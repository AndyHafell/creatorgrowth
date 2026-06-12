"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	Section,
	SectionContent,
	SectionField,
	SectionFields,
} from "@/components/section";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import type { EditorCore } from "@/core";
import { useEditor } from "@/hooks/use-editor";
import { processMediaAssets } from "@/lib/media/processing";
import { buildElementFromMedia } from "@/lib/timeline/element-utils";
import { TICKS_PER_SECOND } from "@/lib/wasm";
import { BatchCommand } from "@/lib/commands";
import { AddTrackCommand, InsertElementCommand } from "@/lib/commands/timeline";
import { cn } from "@/utils/ui";

// Must match the "screen" entry in script.tsx's CG_LANE_CONFIG. If the lane
// name changes there, change it here too — the slicer drops clips onto the
// same row the placeholder flow created.
const SCREEN_LANE_NAME = "🖥️ Screen";

const LS_VID_FOR_PROJECT = (projectId: string) =>
	`cg:vid-for-project:${projectId}`;
const LS_LAST_SRC = (vid: string) => `cg:screen-share-src:${vid}`;
const MIN_SEGMENT_SEC = 0.5;

type Scene = { index: number; title: string };

type DetectResponse = {
	src_url: string;
	duration: number;
	scenes: Scene[];
	boundaries: number[];
};

type CutClip = {
	url: string;
	start: number;
	end: number;
	duration: number;
	scene_index: number;
	scene_title: string;
};

export function ScreenShareView() {
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const projectId = activeProject?.metadata.id ?? null;

	const vid = useMemo(() => {
		if (typeof window === "undefined" || !projectId) return null;
		const direct = window.localStorage.getItem(LS_VID_FOR_PROJECT(projectId));
		if (direct) return direct;
		for (let i = 0; i < window.localStorage.length; i++) {
			const key = window.localStorage.key(i);
			if (!key || !key.startsWith("cg:project-for-vid:")) continue;
			if (window.localStorage.getItem(key) === projectId) {
				const found = key.slice("cg:project-for-vid:".length);
				window.localStorage.setItem(LS_VID_FOR_PROJECT(projectId), found);
				return found;
			}
		}
		return null;
	}, [projectId]);

	if (!projectId) {
		return (
			<EmptyState message="No active project — open one from a creatorgrowth card." />
		);
	}
	if (!vid) {
		return (
			<EmptyState message="This project wasn't opened from a creatorgrowth card. Open the card and click EDITOR to attach a Screen Share." />
		);
	}

	return <ScreenShareEditor vid={vid} projectId={projectId} />;
}

function ScreenShareEditor({
	vid,
	projectId,
}: {
	vid: string;
	projectId: string;
}) {
	const editor = useEditor();

	const [srcUrl, setSrcUrl] = useState(() => {
		if (typeof window === "undefined") return "";
		return window.localStorage.getItem(LS_LAST_SRC(vid)) ?? "";
	});
	const [detecting, setDetecting] = useState(false);
	const [detected, setDetected] = useState<DetectResponse | null>(null);
	const [slicerOpen, setSlicerOpen] = useState(false);

	const runDetect = useCallback(async () => {
		const trimmed = srcUrl.trim();
		if (!trimmed) {
			toast.error("Paste the URL or path of the raw screen-share mp4.");
			return;
		}
		setDetecting(true);
		try {
			const res = await fetch(`/api/videos/${vid}/screen-share/detect`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ src_url: trimmed }),
			});
			const data = await res.json();
			if (!res.ok) {
				toast.error(data.error || `Detect failed (${res.status})`);
				return;
			}
			window.localStorage.setItem(LS_LAST_SRC(vid), trimmed);
			setDetected(data as DetectResponse);
			setSlicerOpen(true);
		} catch (e) {
			toast.error(`Detect error: ${(e as Error).message}`);
		} finally {
			setDetecting(false);
		}
	}, [srcUrl, vid]);

	return (
		<PanelView title="Screen Share">
			<Section>
				<SectionContent>
					<SectionFields>
						<SectionField label="Raw mp4 URL or path">
							<Input
								value={srcUrl}
								onChange={(e) => setSrcUrl(e.target.value)}
								placeholder="https://media.agentflow.net/screen-shares/foo.mp4"
								spellCheck={false}
							/>
							<div className="text-muted-foreground mt-1 text-xs">
								HTTPS URL preferred. Drop file into Syncthing → NAS, then paste
								media URL.
							</div>
						</SectionField>
						<Button onClick={runDetect} disabled={detecting || !srcUrl.trim()}>
							{detecting ? "Detecting…" : "Detect cuts"}
						</Button>
					</SectionFields>
				</SectionContent>
			</Section>
			{detected && !slicerOpen && (
				<Section>
					<SectionContent>
						<div className="text-muted-foreground text-xs">
							Last detect: {detected.scenes.length} scenes ·{" "}
							{formatSeconds(detected.duration)} ·{" "}
							<button
								type="button"
								className="text-foreground underline underline-offset-4"
								onClick={() => setSlicerOpen(true)}
							>
								Reopen slicer
							</button>
						</div>
					</SectionContent>
				</Section>
			)}
			{detected && (
				<SlicerDialog
					open={slicerOpen}
					onOpenChange={setSlicerOpen}
					vid={vid}
					projectId={projectId}
					editor={editor}
					detected={detected}
				/>
			)}
		</PanelView>
	);
}

function SlicerDialog({
	open,
	onOpenChange,
	vid,
	projectId,
	editor,
	detected,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	vid: string;
	projectId: string;
	editor: EditorCore;
	detected: DetectResponse;
}) {
	const { src_url, duration, scenes, boundaries: initialBoundaries } = detected;
	const [boundaries, setBoundaries] = useState<number[]>(initialBoundaries);
	const [cutting, setCutting] = useState(false);
	const [currentTime, setCurrentTime] = useState(0);
	const videoRef = useRef<HTMLVideoElement | null>(null);
	const stripRef = useRef<HTMLDivElement | null>(null);
	const dragRef = useRef<{ index: number; rect: DOMRect } | null>(null);

	// Reset boundaries when a fresh detect comes in.
	useEffect(() => {
		setBoundaries(initialBoundaries);
	}, [initialBoundaries]);

	const segments = useMemo(() => {
		const edges = [0, ...boundaries, duration];
		return scenes.map((scene, i) => ({
			scene,
			start: edges[i] ?? 0,
			end: edges[i + 1] ?? duration,
		}));
	}, [boundaries, duration, scenes]);

	const onMarkerMouseDown = useCallback(
		(index: number) => (e: React.MouseEvent) => {
			if (!stripRef.current) return;
			e.preventDefault();
			dragRef.current = {
				index,
				rect: stripRef.current.getBoundingClientRect(),
			};
		},
		[],
	);

	useEffect(() => {
		const onMove = (e: MouseEvent) => {
			const drag = dragRef.current;
			if (!drag) return;
			const { index, rect } = drag;
			const ratio = Math.min(
				1,
				Math.max(0, (e.clientX - rect.left) / rect.width),
			);
			const t = ratio * duration;
			setBoundaries((prev) => {
				const next = [...prev];
				const minT = (index === 0 ? 0 : next[index - 1]) + MIN_SEGMENT_SEC;
				const maxT =
					(index === next.length - 1 ? duration : next[index + 1]) -
					MIN_SEGMENT_SEC;
				next[index] = Math.min(maxT, Math.max(minT, Math.round(t * 100) / 100));
				return next;
			});
		};
		const onUp = () => {
			dragRef.current = null;
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		return () => {
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
		};
	}, [duration]);

	const seekTo = useCallback(
		(t: number) => {
			const v = videoRef.current;
			if (!v) return;
			v.currentTime = Math.max(0, Math.min(duration - 0.05, t));
		},
		[duration],
	);

	const onAccept = useCallback(async () => {
		setCutting(true);
		try {
			const cutRes = await fetch(`/api/videos/${vid}/screen-share/cut`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					src_url,
					boundaries,
					scenes,
				}),
			});
			const cutData = await cutRes.json();
			if (!cutRes.ok) {
				toast.error(cutData.error || `Cut failed (${cutRes.status})`);
				return;
			}
			const clips: CutClip[] = cutData.clips || [];
			if (!clips.length) {
				toast.error("Cut returned no clips.");
				return;
			}
			await placeClipsOnScreenLane({ editor, projectId, clips });
			toast.success(`Placed ${clips.length} clips on ${SCREEN_LANE_NAME}.`);
			onOpenChange(false);
		} catch (e) {
			toast.error(`Cut error: ${(e as Error).message}`);
		} finally {
			setCutting(false);
		}
	}, [boundaries, editor, onOpenChange, projectId, scenes, src_url, vid]);

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-4xl">
				<DialogHeader>
					<DialogTitle>
						Slice screen-share into {scenes.length} clips
					</DialogTitle>
				</DialogHeader>
				<DialogBody className="space-y-4">
					{/* biome-ignore lint/a11y/useMediaCaption: raw screen-share preview, captions live downstream */}
					<video
						ref={videoRef}
						src={src_url}
						controls
						preload="metadata"
						className="w-full rounded bg-black aspect-video"
						onTimeUpdate={(e) =>
							setCurrentTime((e.target as HTMLVideoElement).currentTime)
						}
					/>
					<TimelineStrip
						ref={stripRef}
						duration={duration}
						boundaries={boundaries}
						scenes={scenes}
						currentTime={currentTime}
						onMarkerMouseDown={onMarkerMouseDown}
					/>
					<div className="space-y-1">
						{segments.map((seg) => (
							<div
								key={seg.scene.index}
								className="flex items-center gap-3 rounded border px-3 py-2 text-sm"
							>
								<span className="font-mono text-muted-foreground w-8 shrink-0">
									{String(seg.scene.index).padStart(2, "0")}
								</span>
								<span className="flex-1 truncate">{seg.scene.title}</span>
								<span className="font-mono text-muted-foreground text-xs whitespace-nowrap">
									{formatSeconds(seg.start)} → {formatSeconds(seg.end)} (
									{formatSeconds(seg.end - seg.start)})
								</span>
								<Button
									variant="ghost"
									size="sm"
									onClick={() => seekTo(seg.start)}
								>
									Jump
								</Button>
							</div>
						))}
					</div>
				</DialogBody>
				<DialogFooter>
					<Button
						variant="ghost"
						onClick={() => onOpenChange(false)}
						disabled={cutting}
					>
						Cancel
					</Button>
					<Button onClick={onAccept} disabled={cutting}>
						{cutting ? "Cutting…" : `Accept · cut into ${scenes.length} clips`}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function TimelineStrip({
	ref,
	duration,
	boundaries,
	scenes,
	currentTime,
	onMarkerMouseDown,
}: {
	ref: React.Ref<HTMLDivElement>;
	duration: number;
	boundaries: number[];
	scenes: Scene[];
	currentTime: number;
	onMarkerMouseDown: (index: number) => (e: React.MouseEvent) => void;
}) {
	const playheadPct = duration > 0 ? (currentTime / duration) * 100 : 0;
	return (
		<div
			ref={ref}
			className="bg-muted relative h-14 w-full select-none overflow-hidden rounded border"
		>
			{/* tick marks every 60s */}
			{Array.from({ length: Math.floor(duration / 60) }, (_, i) => {
				const t = (i + 1) * 60;
				const left = (t / duration) * 100;
				return (
					<div
						key={`tick-${t}`}
						className="absolute top-0 h-2 w-px bg-foreground/20"
						style={{ left: `${left}%` }}
					/>
				);
			})}
			{/* playhead */}
			<div
				className="bg-primary pointer-events-none absolute top-0 bottom-0 w-px"
				style={{ left: `${playheadPct}%` }}
			/>
			{/* boundary markers — keyed by the scene-seam the boundary divides
			    so React keeps the same DOM node as the boundary's time changes. */}
			{boundaries.map((t, i) => {
				const left = (t / duration) * 100;
				const seamKey = `${scenes[i]?.index ?? i}-${scenes[i + 1]?.index ?? i + 1}`;
				return (
					<div
						key={`bnd-${seamKey}`}
						role="slider"
						tabIndex={0}
						aria-label={`Cut ${i + 1}`}
						aria-valuemin={0}
						aria-valuemax={duration}
						aria-valuenow={t}
						onMouseDown={onMarkerMouseDown(i)}
						onKeyDown={() => {}}
						className={cn(
							"absolute top-0 bottom-0 w-1 -translate-x-1/2",
							"bg-foreground cursor-ew-resize hover:bg-primary",
						)}
						style={{ left: `${left}%` }}
						title={`Cut ${i + 1}: ${formatSeconds(t)}`}
					>
						<div className="bg-foreground text-background absolute -top-5 left-1/2 -translate-x-1/2 rounded px-1 font-mono text-[10px]">
							{formatSeconds(t)}
						</div>
					</div>
				);
			})}
		</div>
	);
}

function EmptyState({ message }: { message: string }) {
	return (
		<div className="text-muted-foreground flex h-full items-center justify-center px-6 text-center text-sm">
			{message}
		</div>
	);
}

function formatSeconds(s: number): string {
	if (!Number.isFinite(s) || s < 0) return "0:00";
	const total = Math.round(s);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const sec = total % 60;
	if (h > 0)
		return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
	return `${m}:${String(sec).padStart(2, "0")}`;
}

async function placeClipsOnScreenLane({
	editor,
	projectId,
	clips,
}: {
	editor: EditorCore;
	projectId: string;
	clips: CutClip[];
}) {
	// 1) Fetch each clip URL as a File, register as a media asset.
	const saved: Array<{
		id: string;
		type: "image" | "video" | "audio";
		name: string;
		duration: number;
		fallbackDuration: number;
	}> = [];
	for (let i = 0; i < clips.length; i++) {
		const c = clips[i];
		const res = await fetch(c.url, { credentials: "include" });
		if (!res.ok) {
			console.warn("[screen-share] fetch failed", c.url, res.status);
			continue;
		}
		const blob = await res.blob();
		const safeTitle = (c.scene_title || `scene-${c.scene_index}`)
			.replace(/[^\w-]+/g, "_")
			.slice(0, 32);
		const filename = `screen_${String(c.scene_index).padStart(2, "0")}_${safeTitle}.mp4`;
		const file = new File([blob], filename, {
			type: blob.type || "video/mp4",
		});
		const processed = await processMediaAssets({ files: [file] });
		for (const asset of processed) {
			const stored = await editor.media.addMediaAsset({ projectId, asset });
			if (!stored) continue;
			saved.push({
				id: stored.id,
				type: stored.type,
				name: stored.name ?? filename,
				duration: stored.duration ?? c.duration,
				fallbackDuration: c.duration,
			});
		}
	}
	if (!saved.length) {
		throw new Error("no clips could be processed");
	}

	// 2) Find or create the 🖥️ Screen track in the active scene's overlay stack.
	const scene = editor.scenes.getActiveScene();
	const existing = scene.tracks.overlay.find(
		(t) => t.type === "video" && t.name === SCREEN_LANE_NAME,
	);
	const cmds: Array<AddTrackCommand | InsertElementCommand> = [];
	let trackId: string;
	if (existing) {
		trackId = existing.id;
	} else {
		const addCmd = new AddTrackCommand("video", 0, SCREEN_LANE_NAME);
		cmds.push(addCmd);
		trackId = addCmd.getTrackId();
	}

	// 3) Place each clip end-to-end starting at t=0 on the Screen lane.
	let cursorTicks = 0;
	for (const s of saved) {
		const durSec = s.duration > 0 ? s.duration : s.fallbackDuration;
		const durTicks = Math.max(1, Math.round(durSec * TICKS_PER_SECOND));
		const element = buildElementFromMedia({
			mediaId: s.id,
			mediaType: s.type,
			name: s.name,
			duration: durTicks,
			startTime: cursorTicks,
		});
		cmds.push(
			new InsertElementCommand({
				element,
				placement: { mode: "explicit", trackId },
			}),
		);
		cursorTicks += durTicks;
	}

	editor.command.execute({ command: new BatchCommand(cmds) });
}
