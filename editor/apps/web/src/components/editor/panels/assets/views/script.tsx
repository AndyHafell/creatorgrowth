"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { EditorCore } from "@/core";
import { useEditor } from "@/hooks/use-editor";
import { processMediaAssets } from "@/lib/media/processing";
import { buildElementFromMedia } from "@/lib/timeline/element-utils";
import { TICKS_PER_SECOND } from "@/lib/wasm";
import { BatchCommand } from "@/lib/commands";
import {
	AddTrackCommand,
	InsertElementCommand,
	RemoveTrackCommand,
	RenameTrackCommand,
} from "@/lib/commands/timeline";
import type { TScene, TrackType } from "@/lib/timeline";
import { cn } from "@/utils/ui";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuSub,
	ContextMenuSubContent,
	ContextMenuSubTrigger,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";

type DocKey = "content" | "bullet" | "say" | "voice" | "visuals" | "diagrams";

type DocState = {
	text: string;
	relPath: string; // only meaningful for content/bullet (file-backed); empty for say (DB-backed)
};

const LS_VID_FOR_PROJECT = (projectId: string) =>
	`cg:vid-for-project:${projectId}`;
const LS_DOC_TEXT = (vid: string, doc: DocKey) => `cg:${doc}-doc:${vid}`;
const LS_DOC_PATH = (vid: string, doc: DocKey) => `cg:${doc}-doc-path:${vid}`;
const LS_FONT_SIZE = "cg:script-font-size";
const LS_LAST_TAB = (projectId: string) =>
	`cg:script-last-tab:${projectId}`;

const SAVE_DEBOUNCE_MS = 1200;
const FONT_SIZES = [14, 16, 18, 20, 22, 24, 28] as const;
const DEFAULT_FONT_SIZE = 18;
const LS_MAX_WORDS = "cg:script-max-words"; // "" = All

// ElevenLabs plan quotas (chars/month) and rough pay-as-you-go overage rate.
// Matches the old creatorgrowth editor's cost estimator.
const EL_QUOTA_CREATOR = 100_000;
const EL_QUOTA_PRO = 500_000;
const EL_OVERAGE_PER_1K_CHARS = 0.15;

// Section markers like `=== STEP 1 ===` are stripped server-side before TTS,
// so we strip the same when counting words/chars locally to match what'll ship.
const SECTION_MARKER_RE = /^\s*=+\s*[A-Z0-9].*=+\s*$/;
function stripSayMarkers(text: string): string {
	return text
		.split("\n")
		.filter((line) => !SECTION_MARKER_RE.test(line))
		.join("\n")
		.trim();
}

type SaveStatus = "idle" | "saving" | "saved" | "error";
type TransformBusy = null | "say" | "audio";

const DOC_LABELS: Record<DocKey, string> = {
	content: "Content",
	bullet: "Bullet",
	say: "Say",
	voice: "Voice",
	visuals: "Visuals",
	diagrams: "Diagrams",
};

export function ScriptView() {
	const activeProject = useEditor((e) => e.project.getActiveOrNull());
	const projectId = activeProject?.metadata.id ?? null;

	const vid = useMemo(() => {
		if (typeof window === "undefined" || !projectId) return null;
		const direct = window.localStorage.getItem(LS_VID_FOR_PROJECT(projectId));
		if (direct) return direct;
		// Backfill: bridges before 2026-05-15 only set the forward mapping.
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
			<EmptyState message="No active project — open one to see its script." />
		);
	}
	if (!vid) {
		return (
			<EmptyState message="This project wasn't opened from a creatorgrowth card. Open the card and click EDITOR to attach a script." />
		);
	}

	return <ScriptEditor vid={vid} projectId={projectId} />;
}

function ScriptEditor({
	vid,
	projectId,
}: {
	vid: string;
	projectId: string;
}) {
	const editor = useEditor();

	const [activeDoc, setActiveDoc] = useState<DocKey>(() => {
		if (typeof window === "undefined") return "content";
		const saved = window.localStorage.getItem(LS_LAST_TAB(projectId));
		if (
			saved === "bullet" ||
			saved === "say" ||
			saved === "voice" ||
			saved === "visuals" ||
			saved === "diagrams"
		)
			return saved;
		return "content";
	});

	const [docs, setDocs] = useState<Record<DocKey, DocState>>(() => ({
		content: readLocalDoc(vid, "content"),
		bullet: readLocalDoc(vid, "bullet"),
		say: { text: "", relPath: "" }, // hydrated from /vocal-doc on mount
		voice: { text: "", relPath: "" }, // unused — voice tab has its own data shape
		visuals: { text: "", relPath: "" }, // hydrated from /visuals-doc on mount
		diagrams: { text: "", relPath: "" }, // unused — diagrams tab has its own data shape
	}));

	const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
	const [busy, setBusy] = useState<TransformBusy>(null);
	const [audioProgress, setAudioProgress] = useState<{
		done: number;
		total: number;
	} | null>(null);
	const [fontSize, setFontSize] = useState<number>(() => {
		if (typeof window === "undefined") return DEFAULT_FONT_SIZE;
		const raw = window.localStorage.getItem(LS_FONT_SIZE);
		const n = raw ? Number(raw) : DEFAULT_FONT_SIZE;
		return Number.isFinite(n) ? n : DEFAULT_FONT_SIZE;
	});
	// Empty string means "All"; otherwise positive int caps the slice sent to ElevenLabs.
	const [maxWordsInput, setMaxWordsInput] = useState<string>(() => {
		if (typeof window === "undefined") return "";
		return window.localStorage.getItem(LS_MAX_WORDS) ?? "";
	});

	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const lastSavedRef = useRef<Record<DocKey, string>>({
		content: docs.content.text,
		bullet: docs.bullet.text,
		say: "",
		voice: "",
		visuals: "",
		diagrams: "",
	});

	// Hydrate content/bullet from bootstrap (fresh server-side text)
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(`/api/videos/${vid}/editor-bootstrap`, {
					credentials: "include",
				});
				if (!res.ok) return;
				const payload = await res.json();
				if (cancelled) return;
				const next: Pick<Record<DocKey, DocState>, "content" | "bullet"> = {
					content: {
						text: payload.content_doc?.text ?? "",
						relPath: payload.content_doc?.rel_path ?? "",
					},
					bullet: {
						text: payload.bullet_doc?.text ?? "",
						relPath: payload.bullet_doc?.rel_path ?? "",
					},
				};
				setDocs((prev) => {
					const merged: Record<DocKey, DocState> = { ...prev };
					(["content", "bullet"] as const).forEach((k) => {
						const localUnchanged = prev[k].text === lastSavedRef.current[k];
						if (localUnchanged) {
							merged[k] = next[k];
							lastSavedRef.current[k] = next[k].text;
							if (next[k].text)
								window.localStorage.setItem(LS_DOC_TEXT(vid, k), next[k].text);
							if (next[k].relPath)
								window.localStorage.setItem(LS_DOC_PATH(vid, k), next[k].relPath);
						}
					});
					return merged;
				});
			} catch {
				/* keep localStorage copy */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [vid]);

	// Hydrate say from /vocal-doc
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(`/api/videos/${vid}/vocal-doc`, {
					credentials: "include",
				});
				if (!res.ok) return;
				const body = await res.json();
				if (cancelled) return;
				const text = body.vocal_doc ?? "";
				setDocs((prev) => {
					if (prev.say.text !== lastSavedRef.current.say) return prev; // user typed
					lastSavedRef.current.say = text;
					return { ...prev, say: { text, relPath: "" } };
				});
			} catch {
				/* ignore */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [vid]);

	// Hydrate visuals from /visuals-doc
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				const res = await fetch(`/api/videos/${vid}/visuals-doc`, {
					credentials: "include",
				});
				if (!res.ok) return;
				const body = await res.json();
				if (cancelled) return;
				const text = body.visuals_doc ?? "";
				setDocs((prev) => {
					if (prev.visuals.text !== lastSavedRef.current.visuals) return prev;
					lastSavedRef.current.visuals = text;
					return { ...prev, visuals: { text, relPath: "" } };
				});
			} catch {
				/* ignore */
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [vid]);

	const saveNow = useCallback(
		async (doc: DocKey, text: string, relPath: string) => {
			setSaveStatus("saving");
			try {
				let ok = false;
				if (doc === "say") {
					const res = await fetch(`/api/videos/${vid}/vocal-doc`, {
						method: "POST",
						credentials: "include",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ vocal_doc: text }),
					});
					ok = res.ok && (await res.json())?.ok !== false;
				} else if (doc === "visuals") {
					const res = await fetch(`/api/videos/${vid}/visuals-doc`, {
						method: "POST",
						credentials: "include",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ visuals_doc: text }),
					});
					ok = res.ok && (await res.json())?.ok !== false;
				} else {
					if (!relPath) {
						setSaveStatus("error");
						return;
					}
					const res = await fetch("/api/content/file", {
						method: "PUT",
						credentials: "include",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ path: relPath, content: text }),
					});
					ok = res.ok && (await res.json())?.ok !== false;
				}
				lastSavedRef.current[doc] = text;
				if (doc !== "say" && doc !== "visuals") {
					window.localStorage.setItem(LS_DOC_TEXT(vid, doc), text);
				}
				setSaveStatus(ok ? "saved" : "error");
				if (ok) setTimeout(() => setSaveStatus("idle"), 1500);
			} catch {
				setSaveStatus("error");
			}
		},
		[vid],
	);

	const handleChange = (text: string) => {
		setDocs((prev) => ({ ...prev, [activeDoc]: { ...prev[activeDoc], text } }));
		setSaveStatus("saving");
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		const snapshot = { doc: activeDoc, text, relPath: docs[activeDoc].relPath };
		saveTimerRef.current = setTimeout(() => {
			saveNow(snapshot.doc, snapshot.text, snapshot.relPath);
		}, SAVE_DEBOUNCE_MS);
	};

	const handleTabClick = (next: DocKey) => {
		setActiveDoc(next);
		window.localStorage.setItem(LS_LAST_TAB(projectId), next);
	};

	const cycleFontSize = (dir: 1 | -1) => {
		const idx = FONT_SIZES.indexOf(fontSize as (typeof FONT_SIZES)[number]);
		const next =
			FONT_SIZES[
				Math.max(0, Math.min(FONT_SIZES.length - 1, (idx === -1 ? 3 : idx) + dir))
			];
		setFontSize(next);
		window.localStorage.setItem(LS_FONT_SIZE, String(next));
	};

	// Content → Say (Gemini transform via vocal-doc/generate)
	const generateSay = async () => {
		const contentText = docs.content.text.trim();
		if (!contentText) {
			toast.error("Content doc is empty");
			return;
		}
		setBusy("say");
		try {
			const res = await fetch(`/api/videos/${vid}/vocal-doc/generate`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content_doc: contentText }),
			});
			const body = await res.json();
			if (!res.ok) {
				toast.error(body?.error || "Generation failed");
				return;
			}
			const sayText = (body.vocal_doc || body.text || "").trim();
			if (!sayText) {
				toast.error("Generator returned empty text");
				return;
			}
			// Persist
			await fetch(`/api/videos/${vid}/vocal-doc`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ vocal_doc: sayText }),
			});
			lastSavedRef.current.say = sayText;
			setDocs((prev) => ({ ...prev, say: { text: sayText, relPath: "" } }));
			handleTabClick("say");
			toast.success("Say doc generated");
		} catch (e) {
			toast.error(`Generate failed: ${(e as Error).message}`);
		} finally {
			setBusy(null);
		}
	};

	// Stats for the SAY synthesis cost estimator
	const sayStats = useMemo(() => {
		const stripped = stripSayMarkers(docs.say.text);
		const allWords = stripped ? stripped.split(/\s+/) : [];
		const total = allWords.length;
		const parsed = parseInt(maxWordsInput, 10);
		const cap = Number.isFinite(parsed) && parsed > 0 ? parsed : total;
		const sliceCount = Math.min(cap, total);
		const text = allWords.slice(0, sliceCount).join(" ");
		const chars = text.length;
		const isAll = !maxWordsInput.trim() || cap >= total;
		return { total, sliceCount, chars, isAll, text };
	}, [docs.say.text, maxWordsInput]);

	const updateMaxWords = (val: string) => {
		// Allow empty, or non-negative integers
		const cleaned = val.replace(/[^\d]/g, "");
		setMaxWordsInput(cleaned);
		if (typeof window !== "undefined") {
			window.localStorage.setItem(LS_MAX_WORDS, cleaned);
		}
	};

	// Say → Audio (ElevenLabs synth, then drop into media bin)
	const synthesizeAudio = async () => {
		if (!sayStats.chars) {
			toast.error("Say doc is empty");
			return;
		}
		// Send the RAW say doc (markers intact) so the server can compute step
		// segments from `=== STEP N ===` lines. The server strips markers and
		// truncates to max_words on its end — see _strip_and_segment.
		const textToSend = docs.say.text;
		setBusy("audio");
		setAudioProgress({ done: 0, total: 0 });
		try {
			const kickoff = await fetch(`/api/videos/${vid}/say/synthesize`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					text: textToSend,
					max_words: Math.max(1, sayStats.sliceCount),
				}),
			});
			const kickBody = await kickoff.json();
			if (!kickoff.ok || !kickBody.job_id) {
				toast.error(kickBody?.error || "Synthesis kickoff failed");
				return;
			}
			const jobId = kickBody.job_id as string;

			// Poll
			const POLL_MS = 1500;
			const TIMEOUT_MS = 6 * 60 * 1000;
			const started = Date.now();
			let generationUrl: string | null = null;
			let generation: VoiceGeneration | null = null;
			while (Date.now() - started < TIMEOUT_MS) {
				await new Promise((r) => setTimeout(r, POLL_MS));
				const stat = await fetch(
					`/api/videos/${vid}/say/synthesize/status/${jobId}`,
					{ credentials: "include" },
				);
				const sb = await stat.json();
				setAudioProgress({
					done: sb.chunks_done ?? 0,
					total: sb.chunks_total ?? 0,
				});
				if (sb.status === "done") {
					generation = sb.generation ?? null;
					generationUrl = generation?.url ?? null;
					break;
				}
				if (sb.status === "error") {
					toast.error(sb.error || "Synthesis failed");
					return;
				}
			}
			if (!generationUrl) {
				toast.error("Synthesis timed out");
				return;
			}

			// Fetch the MP3, add to media, and drop it on the audio track at t=0.
			const audioRes = await fetch(generationUrl, { credentials: "include" });
			if (!audioRes.ok) {
				toast.error(`Couldn't fetch generated audio (${audioRes.status})`);
				return;
			}
			const blob = await audioRes.blob();
			const file = new File([blob], `say_${vid}_${Date.now()}.mp3`, {
				type: blob.type || "audio/mpeg",
			});
			await importAudioAndPlace({ editor, projectId, file });
			const placed = await placeSegmentBookmarks(editor, generation?.segments);
			if (placed > 0) {
				toast.success(
					`Audio on timeline — ${placed} step marker${placed === 1 ? "" : "s"} dropped`,
				);
			} else {
				toast.success("Audio added to timeline");
			}
		} catch (e) {
			toast.error(`Synthesis failed: ${(e as Error).message}`);
		} finally {
			setBusy(null);
			setAudioProgress(null);
		}
	};

	const current = docs[activeDoc];
	const hasContent = !!current.text;
	const isFileBacked = activeDoc !== "say" && activeDoc !== "visuals";
	const hasPath = !isFileBacked || !!current.relPath;

	return (
		<div className="flex h-full flex-col">
			<div className="border-b flex items-center justify-between gap-2 px-2 py-1.5">
				<div className="flex items-center gap-0.5">
					{(Object.keys(DOC_LABELS) as DocKey[]).map((k) => (
						<TabButton
							key={k}
							active={activeDoc === k}
							onClick={() => handleTabClick(k)}
						>
							{DOC_LABELS[k]}
						</TabButton>
					))}
				</div>
				<div className="flex items-center gap-1.5">
					<SaveBadge status={saveStatus} />
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 text-[11px]"
						onClick={() => cycleFontSize(-1)}
						aria-label="Decrease font size"
					>
						A−
					</button>
					<span className="text-muted-foreground w-7 text-center text-[11px] tabular-nums">
						{fontSize}
					</span>
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground rounded px-1.5 py-0.5 text-[11px]"
						onClick={() => cycleFontSize(1)}
						aria-label="Increase font size"
					>
						A+
					</button>
				</div>
			</div>

			{/* Per-tab action row */}
			{activeDoc === "content" && (
				<ActionRow>
					<ActionButton
						onClick={generateSay}
						disabled={busy !== null || !docs.content.text.trim()}
						busy={busy === "say"}
					>
						{busy === "say" ? "Generating Say…" : "Generate Say →"}
					</ActionButton>
				</ActionRow>
			)}
			{activeDoc === "say" && (
				<>
					<ActionRow>
						<ActionButton
							onClick={generateSay}
							disabled={busy !== null || !docs.content.text.trim()}
							busy={busy === "say"}
							variant="ghost"
						>
							{busy === "say" ? "Regenerating…" : "Regenerate from Content"}
						</ActionButton>
						<ActionButton
							onClick={synthesizeAudio}
							disabled={busy !== null || !sayStats.chars}
							busy={busy === "audio"}
						>
							{busy === "audio"
								? audioProgress && audioProgress.total > 0
									? `Synthesizing… ${audioProgress.done}/${audioProgress.total}`
									: "Synthesizing…"
								: "Synthesize Audio →"}
						</ActionButton>
					</ActionRow>
					<SynthMeter
						stats={sayStats}
						maxWordsInput={maxWordsInput}
						onMaxWordsChange={updateMaxWords}
					/>
				</>
			)}

			{activeDoc === "diagrams" ? (
				<DiagramsTab vid={vid} projectId={projectId} />
			) : activeDoc === "voice" ? (
				<VoiceTab vid={vid} projectId={projectId} />
			) : activeDoc === "visuals" ? (
				<VisualsTab vid={vid} projectId={projectId} fontSize={fontSize} />
			) : !hasPath ? (
				<EmptyState
					message={`No "${DOC_LABELS[activeDoc]} Doc" attached to this card. Set it from creatorgrowth.`}
				/>
			) : (
				<textarea
					key={activeDoc}
					value={current.text}
					onChange={(e) => handleChange(e.target.value)}
					spellCheck
					placeholder={
						hasContent
							? ""
							: `${DOC_LABELS[activeDoc]} doc is empty${activeDoc === "say" ? " — click \"Generate Say\" from the Content tab" : " — start typing…"}`
					}
					className={cn(
						"flex-1 min-h-0 w-full resize-none bg-transparent px-4 py-3",
						"text-foreground placeholder:text-muted-foreground/60",
						"outline-none focus:outline-none border-0",
						"font-[Helvetica_Neue,Helvetica,Arial,sans-serif]",
					)}
					style={{ fontSize: `${fontSize}px`, lineHeight: 1.7 }}
				/>
			)}
		</div>
	);
}

function readLocalDoc(vid: string, doc: DocKey): DocState {
	if (typeof window === "undefined") return { text: "", relPath: "" };
	return {
		text: window.localStorage.getItem(LS_DOC_TEXT(vid, doc)) ?? "",
		relPath: window.localStorage.getItem(LS_DOC_PATH(vid, doc)) ?? "",
	};
}

function TabButton({
	active,
	onClick,
	children,
}: {
	active: boolean;
	onClick: () => void;
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				"rounded px-2 py-1 text-xs font-medium transition-colors",
				active
					? "bg-accent text-foreground"
					: "text-muted-foreground hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

function ActionRow({ children }: { children: React.ReactNode }) {
	return (
		<div className="border-b flex items-center justify-end gap-2 px-2 py-1.5">
			{children}
		</div>
	);
}

function ActionButton({
	onClick,
	disabled,
	busy,
	variant = "primary",
	children,
}: {
	onClick: () => void;
	disabled?: boolean;
	busy?: boolean;
	variant?: "primary" | "ghost";
	children: React.ReactNode;
}) {
	return (
		<button
			type="button"
			onClick={onClick}
			disabled={disabled}
			className={cn(
				"rounded px-2.5 py-1 text-xs font-medium transition-colors",
				"disabled:opacity-50 disabled:cursor-not-allowed",
				variant === "primary"
					? "bg-foreground text-background hover:opacity-90"
					: "text-muted-foreground hover:text-foreground",
				busy && "animate-pulse",
			)}
		>
			{children}
		</button>
	);
}

type VoiceSegment = {
	name: string;
	start: number;
	end: number;
	char_start?: number;
	char_end?: number;
};

type VoiceGeneration = {
	url: string;
	voice_id?: string;
	model_id?: string;
	words?: number;
	chars?: number;
	bytes?: number;
	chunks?: number;
	duration?: number;
	generated_at?: string;
	preview?: string;
	segments?: VoiceSegment[];
	segments_method?: string;
};

// Brand gold for auto-dropped step bookmarks; user can change/delete.
const SEGMENT_BOOKMARK_COLOR = "#E8A800";

/**
 * Add the audio asset to the project AND drop it on the timeline's audio
 * track at t=0 so the user doesn't have to drag it manually. Returns the
 * saved MediaAsset (or null if the save failed).
 */
async function importAudioAndPlace({
	editor,
	projectId,
	file,
}: {
	editor: EditorCore;
	projectId: string;
	file: File;
}) {
	const processed = await processMediaAssets({ files: [file] });
	let savedAny: { id: string; type: string; duration?: number } | null = null;
	for (const asset of processed) {
		const saved = await editor.media.addMediaAsset({ projectId, asset });
		if (!saved) continue;
		savedAny = saved;
		const durationSec = saved.duration ?? 0;
		const duration = durationSec > 0
			? Math.round(durationSec * TICKS_PER_SECOND)
			: undefined;
		const element = buildElementFromMedia({
			mediaId: saved.id,
			mediaType: saved.type,
			name: saved.name ?? file.name,
			duration: duration ?? Math.round(60 * TICKS_PER_SECOND),
			startTime: 0,
		});
		try {
			editor.timeline.insertElement({
				element,
				placement: { mode: "auto", trackType: "audio" },
			});
		} catch (err) {
			console.warn("[voice] timeline insert failed", err);
		}
	}
	return savedAny;
}

/**
 * Drop one bookmark per Say-doc segment on the active scene's timeline.
 * Idempotent enough: if a bookmark exists at the exact same time, only the
 * note/color is updated (no duplicate added).
 */
async function placeSegmentBookmarks(
	editor: EditorCore,
	segments: VoiceSegment[] | undefined,
) {
	if (!segments?.length) return 0;
	let placed = 0;
	for (const seg of segments) {
		if (!Number.isFinite(seg.start)) continue;
		// Timeline state is in ticks, not seconds.
		const time = Math.max(0, Math.round(seg.start * TICKS_PER_SECOND));
		try {
			if (!editor.scenes.isBookmarked({ time })) {
				await editor.scenes.toggleBookmark({ time });
			}
			await editor.scenes.updateBookmark({
				time,
				updates: { note: seg.name, color: SEGMENT_BOOKMARK_COLOR },
			});
			placed++;
		} catch (err) {
			console.warn("[script] placeSegmentBookmark failed", seg, err);
		}
	}
	return placed;
}

/** Extract a step number from a string like "Step 1: Title" or "STEP 2". */
function stepNumberOf(s: string): number | null {
	const m = (s || "").match(/step\s*(\d+)/i);
	return m ? parseInt(m[1], 10) : null;
}


function VoiceTab({ vid, projectId }: { vid: string; projectId: string }) {
	const editor = useEditor();
	const [generations, setGenerations] = useState<VoiceGeneration[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [importingUrl, setImportingUrl] = useState<string | null>(null);
	const [deletingIdx, setDeletingIdx] = useState<number | null>(null);
	const [placingMarkersIdx, setPlacingMarkersIdx] = useState<number | null>(null);
	const [computingIdx, setComputingIdx] = useState<number | null>(null);

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch(`/api/videos/${vid}/say/voiceover`, {
				credentials: "include",
			});
			if (!res.ok) {
				setError(`Couldn't load voiceovers (${res.status})`);
				return;
			}
			const body = await res.json();
			setGenerations(Array.isArray(body?.generations) ? body.generations : []);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setLoading(false);
		}
	}, [vid]);

	useEffect(() => {
		load();
	}, [load]);

	const addToMedia = async (g: VoiceGeneration) => {
		if (!g.url) return;
		setImportingUrl(g.url);
		try {
			const res = await fetch(g.url, { credentials: "include" });
			if (!res.ok) {
				toast.error(`Couldn't fetch audio (${res.status})`);
				return;
			}
			const blob = await res.blob();
			const ts = (g.generated_at || "").replace(/[^\d]/g, "").slice(0, 12) ||
				Date.now().toString();
			const file = new File([blob], `voice_${vid}_${ts}.mp3`, {
				type: blob.type || "audio/mpeg",
			});
			await importAudioAndPlace({ editor, projectId, file });
			const placed = await placeSegmentBookmarks(editor, g.segments);
			if (placed > 0) {
				toast.success(
					`Voiceover on timeline — ${placed} step marker${placed === 1 ? "" : "s"} dropped`,
				);
			} else {
				toast.success("Voiceover added to timeline");
			}
		} catch (e) {
			toast.error(`Import failed: ${(e as Error).message}`);
		} finally {
			setImportingUrl(null);
		}
	};

	// Compute segments via the backfill endpoint and update local state.
	// Returns the fresh segments array (or null on failure).
	const computeSegmentsFor = async (
		idx: number,
	): Promise<VoiceSegment[] | null> => {
		const res = await fetch(
			`/api/videos/${vid}/say/voiceover/${idx}/compute-segments`,
			{ method: "POST", credentials: "include" },
		);
		const body = await res.json();
		if (!res.ok) {
			toast.error(body?.error || `Compute failed (${res.status})`);
			return null;
		}
		const segs: VoiceSegment[] = body.segments ?? [];
		// Reflect new segments in our state so the card label updates.
		setGenerations((prev) =>
			prev
				? prev.map((g, i) =>
						i === idx
							? { ...g, segments: segs, segments_method: "linear-approx" }
							: g,
					)
				: prev,
		);
		return segs;
	};

	// A "1 INTRO segment" take was made before the marker-aware backend was
	// deployed — backfill is needed to get real step segments.
	const needsCompute = (g: VoiceGeneration) => {
		const segs = g.segments ?? [];
		if (segs.length === 0) return true;
		if (segs.length === 1 && /intro/i.test(segs[0].name)) return true;
		return false;
	};

	const placeMarkers = async (g: VoiceGeneration, idx: number) => {
		setPlacingMarkersIdx(idx);
		try {
			let segments = g.segments ?? [];
			if (needsCompute(g)) {
				setComputingIdx(idx);
				const fresh = await computeSegmentsFor(idx);
				setComputingIdx(null);
				if (!fresh) return;
				segments = fresh;
			}
			if (!segments.length) {
				toast.error("No step markers in this take.");
				return;
			}
			const placed = await placeSegmentBookmarks(editor, segments);
			if (placed > 0) {
				toast.success(`Placed ${placed} step marker${placed === 1 ? "" : "s"}`);
			} else {
				toast.error("No markers placed");
			}
		} finally {
			setPlacingMarkersIdx(null);
		}
	};

	const deleteGen = async (idx: number) => {
		setDeletingIdx(idx);
		try {
			const res = await fetch(`/api/videos/${vid}/say/voiceover/${idx}`, {
				method: "DELETE",
				credentials: "include",
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				toast.error(body?.error || `Delete failed (${res.status})`);
				return;
			}
			const body = await res.json();
			setGenerations(Array.isArray(body?.generations) ? body.generations : []);
			toast.success("Voiceover deleted");
		} catch (e) {
			toast.error(`Delete failed: ${(e as Error).message}`);
		} finally {
			setDeletingIdx(null);
		}
	};

	const hasAny = !!generations?.length;

	return (
		<div className="flex h-full flex-col">
			<div className="border-b flex items-center justify-between gap-2 px-3 py-1.5">
				<span className="text-muted-foreground text-[11px]">
					{loading
						? "Loading voiceovers…"
						: error
							? "Error"
							: hasAny
								? `${generations!.length} voiceover${generations!.length === 1 ? "" : "s"}`
								: "No voiceovers yet"}
				</span>
				<button
					type="button"
					onClick={load}
					className="text-muted-foreground hover:text-foreground text-[11px]"
				>
					Refresh
				</button>
			</div>
			<div className="flex-1 min-h-0 overflow-y-auto p-2">
				{error && (
					<div className="text-red-500 px-2 py-1 text-xs">{error}</div>
				)}
				{!error && !loading && !hasAny && (
					<div className="text-muted-foreground px-2 py-6 text-center text-sm">
						No voiceovers yet. Go to the <strong>Say</strong> tab and click{" "}
						<strong>Synthesize Audio →</strong> to generate one.
					</div>
				)}
				{generations
					?.map((g, i) => ({ g, i }))
					.reverse()
					.map(({ g, i }) => (
						<VoiceCard
							key={`${g.url}-${i}`}
							gen={g}
							idx={i}
							onAddToMedia={() => addToMedia(g)}
							onPlaceMarkers={() => placeMarkers(g, i)}
							onDelete={() => deleteGen(i)}
							importing={importingUrl === g.url}
							deleting={deletingIdx === i}
							placingMarkers={placingMarkersIdx === i}
							computing={computingIdx === i}
							needsCompute={needsCompute(g)}
						/>
					))}
			</div>
		</div>
	);
}

function VoiceCard({
	gen,
	idx,
	onAddToMedia,
	onPlaceMarkers,
	onDelete,
	importing,
	deleting,
	placingMarkers,
	computing,
	needsCompute,
}: {
	gen: VoiceGeneration;
	idx: number;
	onAddToMedia: () => void;
	onPlaceMarkers: () => void;
	onDelete: () => void;
	importing: boolean;
	deleting: boolean;
	placingMarkers: boolean;
	computing: boolean;
	needsCompute: boolean;
}) {
	const segCount = gen.segments?.length ?? 0;
	const approx = gen.segments_method === "linear-approx";
	const generatedAt = gen.generated_at
		? new Date(gen.generated_at).toLocaleString(undefined, {
				month: "short",
				day: "numeric",
				hour: "numeric",
				minute: "2-digit",
			})
		: "";
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div className="group relative mb-2 rounded border p-2.5">
					<div className="mb-1 flex items-center justify-between gap-2">
						<div className="text-foreground text-xs font-medium">
							Take {idx + 1}
						</div>
						<div className="text-muted-foreground text-[10px]">
							{generatedAt}
							{typeof gen.words === "number" && (
								<>
									{" · "}
									{gen.words.toLocaleString()} words
								</>
							)}
							{typeof gen.chars === "number" && (
								<>
									{" · "}
									{gen.chars.toLocaleString()} chars
								</>
							)}
						</div>
					</div>
					{gen.preview && (
						<div className="text-muted-foreground mb-1.5 line-clamp-2 text-[11px] italic">
							{gen.preview}
						</div>
					)}
					{gen.url && (
						<audio
							controls
							preload="none"
							src={gen.url}
							className="w-full"
							style={{ height: 32 }}
						/>
					)}
					<div className="mt-1.5 flex items-center justify-end gap-1.5">
						<button
							type="button"
							onClick={onPlaceMarkers}
							disabled={placingMarkers || computing}
							title={
								needsCompute
									? "Computes step markers from say doc + audio (free, linear approx) then drops them on the timeline"
									: approx
										? `${segCount} segments (linear approx; ~1-2s drift per step)`
										: `${segCount} step segment${segCount === 1 ? "" : "s"}`
							}
							className={cn(
								"text-muted-foreground hover:text-foreground rounded px-2.5 py-1 text-xs",
								"disabled:opacity-50 disabled:cursor-not-allowed",
								(placingMarkers || computing) && "animate-pulse",
							)}
						>
							{computing
								? "Computing…"
								: placingMarkers
									? "Placing…"
									: needsCompute
										? "Place markers"
										: `Place markers (${segCount}${approx ? "~" : ""})`}
						</button>
						<button
							type="button"
							onClick={onAddToMedia}
							disabled={importing || !gen.url}
							className={cn(
								"bg-foreground text-background rounded px-2.5 py-1 text-xs font-medium hover:opacity-90",
								"disabled:opacity-50 disabled:cursor-not-allowed",
								importing && "animate-pulse",
							)}
						>
							{importing ? "Adding…" : "Add to Timeline"}
						</button>
					</div>
				</div>
			</ContextMenuTrigger>
			<ContextMenuContent>
				<ContextMenuItem
					variant="destructive"
					disabled={deleting}
					onClick={onDelete}
				>
					{deleting ? "Deleting…" : "Delete take"}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
}

type DiagramRow = {
	id: string;
	name: string;
	position: number;
	image_path_url?: string | null;
	audio_path_url?: string | null;
	result_url?: string | null;
	result_meta?: { duration?: number } | null;
	boxes?: unknown[];
	updated_at?: string;
};

function DiagramsTab({ vid, projectId }: { vid: string; projectId: string }) {
	const editor = useEditor();
	const [diagrams, setDiagrams] = useState<DiagramRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [generating, setGenerating] = useState(false);
	const [placingAll, setPlacingAll] = useState(false);
	const [previewId, setPreviewId] = useState<string | null>(null);
	const previewDiagram = diagrams?.find((d) => d.id === previewId) ?? null;

	const load = useCallback(async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await fetch(`/api/videos/${vid}/diagrams`, {
				credentials: "include",
			});
			if (!res.ok) {
				setError(`Couldn't load diagrams (${res.status})`);
				return;
			}
			const body = await res.json();
			setDiagrams(Array.isArray(body) ? body : []);
		} catch (e) {
			setError((e as Error).message);
		} finally {
			setLoading(false);
		}
	}, [vid]);

	useEffect(() => {
		load();
	}, [load]);

	const openStudio = () => {
		const url = `https://creatorgrowth.com/?card=${encodeURIComponent(vid)}&studio=diagrams`;
		window.open(url, "_blank", "noopener");
	};

	const placeAllOnTimeline = async () => {
		if (!diagrams?.length) {
			toast.error("No diagrams yet");
			return;
		}
		setPlacingAll(true);
		try {
			const res = await fetch(`/api/videos/${vid}/diagrams/auto-place`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
			});
			const body = await res.json();
			if (!res.ok) {
				toast.error(body?.error || `auto-place failed (${res.status})`);
				return;
			}
			type Placement = {
				diagram_id: string;
				name?: string;
				matched: boolean;
				match_method?:
					| "verbatim_script"
					| "step_fallback"
					| "even_distribution";
				reason?: string;
				result_url?: string;
				start?: number;
				end?: number;
			};
			const all: Placement[] = body.placements || [];
			const matched = all.filter((p) => p.matched && p.result_url);
			if (matched.length === 0) {
				const reasons = all
					.filter((p) => !p.matched)
					.slice(0, 3)
					.map((p) => `• ${p.name || p.diagram_id}: ${p.reason || "no match"}`)
					.join("\n");
				toast.error(
					`Nothing placed — no diagram scripts matched the vocal_doc.\n${reasons}`,
				);
				return;
			}

			type Pending = {
				name: string;
				mediaId: string;
				mediaType: "image" | "video" | "audio";
				startTime: number;
				duration: number;
			};
			const pending: Pending[] = [];
			let importFailed = 0;
			for (const p of matched) {
				try {
					const r = await fetch(p.result_url!, { credentials: "include" });
					if (!r.ok) {
						importFailed++;
						continue;
					}
					const blob = await r.blob();
					const mime = blob.type || "video/mp4";
					const ext = (mime.split("/")[1] || "mp4").replace(
						/[^a-z0-9]/gi,
						"",
					);
					const file = new File(
						[blob],
						`diagram_${p.diagram_id}.${ext}`,
						{ type: mime },
					);
					const processed = await processMediaAssets({ files: [file] });
					for (const asset of processed) {
						const saved = await editor.media.addMediaAsset({
							projectId,
							asset,
						});
						if (!saved) {
							importFailed++;
							continue;
						}
						const startTime = Math.max(
							0,
							Math.round((p.start ?? 0) * TICKS_PER_SECOND),
						);
						const span = Math.max(0.5, (p.end ?? 0) - (p.start ?? 0));
						pending.push({
							name: p.name || "Diagram",
							mediaId: saved.id,
							mediaType: saved.type,
							startTime,
							duration: Math.round(span * TICKS_PER_SECOND),
						});
					}
				} catch (err) {
					console.warn(`[diagrams] import ${p.diagram_id} failed`, err);
					importFailed++;
				}
			}

			if (pending.length === 0) {
				toast.error("All diagram imports failed — check console");
				return;
			}

			const scene = editor.scenes.getActiveScene();
			const lanePlan = planCgLanes({
				scene,
				lanesUsed: new Set<CgLane>(["diagrams"]),
			});
			const trackId = lanePlan.diagrams!.trackId;
			const cmds: Array<
				| AddTrackCommand
				| RemoveTrackCommand
				| RenameTrackCommand
				| InsertElementCommand
			> = [...emitCgLaneCommands(lanePlan, detectStaleCgTracks(scene))];
			for (const p of pending) {
				cmds.push(
					new InsertElementCommand({
						element: buildElementFromMedia({
							mediaId: p.mediaId,
							mediaType: p.mediaType,
							name: p.name,
							duration: p.duration,
							startTime: p.startTime,
						}),
						placement: { mode: "explicit", trackId },
					}),
				);
			}
			editor.command.execute({ command: new BatchCommand(cmds) });

			const unmatched = all.filter((p) => !p.matched);
			// Log the full match report so Andy can open devtools and see why each
			// failed (no script / no result_url / script not found in vocal_doc).
			console.group("[diagrams/auto-place] match report");
			console.info(
				`matched ${matched.length} / total ${all.length} • method=${body.method} • duration=${body.duration}s • cleaned_chars=${body.total_chars}`,
			);
			if (matched.length) {
				console.table(
					matched.map((p) => ({
						name: p.name,
						start: p.start,
						end: p.end,
						method: p.match_method,
					})),
				);
			}
			const exactMatches = matched.filter(
				(p) => p.match_method === "verbatim_script",
			).length;
			const stepFallbacks = matched.filter(
				(p) => p.match_method === "step_fallback",
			).length;
			const evenSpread = matched.filter(
				(p) => p.match_method === "even_distribution",
			).length;
			if (unmatched.length) {
				console.warn(`${unmatched.length} unmatched:`);
				console.table(
					unmatched.map((p) => ({
						name: p.name,
						reason: p.reason,
						script_preview: (p as { script_preview?: string }).script_preview,
					})),
				);
			}
			console.groupEnd();

			const parts = [`Placed ${pending.length} diagram${pending.length === 1 ? "" : "s"}`];
			const methodBits: string[] = [];
			if (exactMatches) methodBits.push(`${exactMatches} exact`);
			if (stepFallbacks) methodBits.push(`${stepFallbacks} step-fallback`);
			if (evenSpread) methodBits.push(`${evenSpread} even-spread`);
			if (methodBits.length > 1) parts.push(methodBits.join(", "));
			else if (evenSpread === matched.length)
				parts.push("even-spread — fill in diagram.script for exact timing");
			else if (stepFallbacks === matched.length)
				parts.push("step-fallback — fill in diagram.script for exact timing");
			if (unmatched.length) parts.push(`${unmatched.length} unmatched (see console)`);
			if (importFailed) parts.push(`${importFailed} import failed`);
			if (body.method === "estimate-13cps")
				parts.push("(timing estimated — synth audio for precision)");
			toast.success(parts.join(" • "));
		} catch (e) {
			toast.error(`Place all failed: ${(e as Error).message}`);
		} finally {
			setPlacingAll(false);
		}
	};

	const deleteDiagram = useCallback(
		async (id: string, name: string) => {
			try {
				const res = await fetch(`/api/diagrams/${id}`, {
					method: "DELETE",
					credentials: "include",
				});
				if (!res.ok) {
					const body = await res.json().catch(() => ({}));
					toast.error(body?.error || `Delete failed (${res.status})`);
					return false;
				}
				toast.success(`Deleted "${name}"`);
				setDiagrams((prev) => (prev ?? []).filter((d) => d.id !== id));
				return true;
			} catch (e) {
				toast.error(`Delete failed: ${(e as Error).message}`);
				return false;
			}
		},
		[],
	);

	const generate = async () => {
		console.info("[diagrams] generate clicked", { vid });
		setGenerating(true);
		setError(null);
		try {
			const res = await fetch(`/api/videos/${vid}/diagrams/generate-batch`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({}),
			});
			const body = await res.json().catch(() => ({}));
			console.info("[diagrams] generate response", res.status, body);
			if (!res.ok) {
				const msg = body?.error || `Generation failed (${res.status})`;
				setError(msg);
				toast.error(msg);
				return;
			}
			const created = body.created?.length ?? 0;
			const failed = body.failed ?? 0;
			if (created > 0 && failed === 0) {
				toast.success(`Generated ${created} diagram${created === 1 ? "" : "s"}`);
			} else if (created > 0) {
				toast.warning(`Generated ${created}, ${failed} failed`);
			} else {
				const msg = "No diagrams generated — check server logs";
				setError(msg);
				toast.error(msg);
			}
			await load();
		} catch (e) {
			const msg = `Generation failed: ${(e as Error).message}`;
			setError(msg);
			toast.error(msg);
		} finally {
			setGenerating(false);
		}
	};

	const hasDiagrams = !!diagrams?.length;

	return (
		<div className="flex h-full flex-col">
			<div className="border-b flex items-center justify-between gap-2 px-3 py-1.5">
				<span className="text-muted-foreground text-[11px]">
					{loading
						? "Loading diagrams…"
						: error
							? "Error"
							: hasDiagrams
								? `${diagrams!.length} diagram${diagrams!.length === 1 ? "" : "s"}`
								: "No diagrams yet"}
				</span>
				<div className="flex items-center gap-1.5">
					<button
						type="button"
						onClick={load}
						disabled={generating || placingAll}
						className="text-muted-foreground hover:text-foreground text-[11px] disabled:opacity-50"
					>
						Refresh
					</button>
					<button
						type="button"
						onClick={placeAllOnTimeline}
						disabled={generating || placingAll || !diagrams?.length}
						title="Add each diagram to media + drop on the video track at its step's start time"
						className={cn(
							"text-muted-foreground hover:text-foreground rounded px-2 py-1 text-xs",
							"disabled:opacity-50 disabled:cursor-not-allowed",
							placingAll && "animate-pulse",
						)}
					>
						{placingAll ? "Placing…" : "Place on timeline"}
					</button>
					<button
						type="button"
						onClick={generate}
						disabled={generating || placingAll}
						className={cn(
							"bg-foreground text-background rounded px-2.5 py-1 text-xs font-medium transition-colors hover:opacity-90",
							"disabled:opacity-50 disabled:cursor-not-allowed",
							generating && "animate-pulse",
						)}
					>
						{generating ? "Generating…" : "Generate all"}
					</button>
					<button
						type="button"
						onClick={openStudio}
						disabled={generating || placingAll}
						className="text-muted-foreground hover:text-foreground rounded px-2 py-1 text-xs disabled:opacity-50"
					>
						Open Studio →
					</button>
				</div>
			</div>

			<div className="flex-1 min-h-0 overflow-y-auto p-2">
				{error && (
					<div className="text-red-500 px-2 py-1 text-xs">{error}</div>
				)}
				{generating && (
					<div className="text-muted-foreground px-2 py-2 text-center text-xs">
						Generating diagrams via Gemini Nano Banana 2… typically 30–60s for 7
						chapters. The list will refresh when done.
					</div>
				)}
				{!error && !loading && !generating && !hasDiagrams && (
					<div className="text-muted-foreground px-2 py-6 text-center text-sm">
						No diagrams yet. Click <strong>Generate from Script</strong> to
						create one per step from your Content/Bullet doc, or open the Studio
						to draw manually.
					</div>
				)}
				{diagrams?.map((d) => (
					<DiagramCard
						key={d.id}
						diagram={d}
						onClick={() => setPreviewId(d.id)}
						onDelete={() => deleteDiagram(d.id, d.name)}
					/>
				))}
			</div>

			{previewDiagram && (
				<DiagramPreview
					diagram={previewDiagram}
					diagrams={diagrams ?? []}
					onNavigate={(id) => setPreviewId(id)}
					onClose={() => setPreviewId(null)}
					onUpdated={(updated) => {
						setDiagrams((prev) =>
							(prev ?? []).map((d) => (d.id === updated.id ? updated : d)),
						);
					}}
					onDeleted={(id) => {
						setDiagrams((prev) => (prev ?? []).filter((d) => d.id !== id));
					}}
				/>
			)}
		</div>
	);
}

// ---------------------------------------------------------------------------
// Visuals tab — right-click selection tagging
//
// Andy reads through the cleaned vocal_doc, selects ranges, right-clicks, and
// picks Diagram/Avatar/Text anim/Screen. Each tag stores its char_start/end in
// the cleaned-doc coordinate space. "Apply to timeline" maps each to a clip.
// ---------------------------------------------------------------------------

type VisualTagType =
	| "diagram"
	| "avatar"
	| "text_anim"
	| "screen"
	| "chapter"
	| "chapters";

type VisualTag = {
	id: string;
	char_start: number;
	char_end: number;
	type: VisualTagType;
	asset_id?: string;
	label?: string;
};

// Dark saturated palette — sits comfortably on the editor's near-black bg.
// bg = ~22% opacity of the accent color, fg = a bright readable version.
const TAG_STYLES: Record<VisualTagType, { bg: string; fg: string; label: string }> = {
	diagram: { bg: "rgba(228, 75, 132, 0.28)", fg: "#f4a4c0", label: "Diagram" },
	avatar: { bg: "rgba(60, 150, 220, 0.28)", fg: "#9ccfee", label: "Avatar" },
	text_anim: { bg: "rgba(210, 160, 50, 0.28)", fg: "#e8c578", label: "Text anim" },
	screen: { bg: "rgba(160, 100, 220, 0.28)", fg: "#c9a3ee", label: "Screen" },
	chapter: { bg: "rgba(255, 140, 60, 0.28)", fg: "#ffc188", label: "Chapter" },
	chapters: { bg: "rgba(80, 200, 140, 0.28)", fg: "#a5e6c4", label: "Chapters" },
};

const STEP_MARKER_RE = /^\s*=+\s*([A-Z0-9][^=]*?)\s*=+\s*$/;

// ---------------------------------------------------------------------------
// Named overlay tracks: one row per visual asset class.
//
// Stack top → bottom (overlay[0] is topmost in the timeline UI and compositing):
//   Motion Graphics — text/logo/image animations on top of everything
//   Avatar          — HeyGen avatar clips (placeholder image until real render)
//   Diagrams        — diagram MP4s + still images
//   Screen          — screen-recording placeholders (and real .mov clips later)
//
// All lanes are VIDEO tracks so placeholders can be color-block PNGs (generated
// client-side) that swap cleanly when real footage arrives. Diagrams already
// emits real MP4s; other lanes use placeholder images for now.
//
// On legacy projects: the only track we reuse-by-name is "🎨 Diagrams" (since
// the prior deploy may have created it). All other lanes get a fresh video
// track. Old text-typed placeholder tracks from the prior deploy are left
// alone — the user can delete them. We never claim/rename across track types.
// ---------------------------------------------------------------------------
type CgLane = "motion" | "avatar" | "diagrams" | "screen";
type CgLanePlaceholder = { label: string; bgColor: string };
const CG_LANE_CONFIG: Record<
	CgLane,
	{
		name: string;
		type: Exclude<TrackType, "audio">;
		placeholder?: CgLanePlaceholder;
	}
> = {
	motion: {
		name: "🎬 Motion Graphics",
		type: "video",
		placeholder: { label: "✨ TEXT", bgColor: "#8d6e00" },
	},
	avatar: {
		name: "🧑 Avatar",
		type: "video",
		placeholder: { label: "🧑 AVATAR", bgColor: "#1e4a6e" },
	},
	diagrams: { name: "🎨 Diagrams", type: "video" }, // real MP4s, no placeholder needed
	screen: {
		name: "🖥️ Screen",
		type: "video",
		placeholder: { label: "📺 SCREEN", bgColor: "#6a1b9a" },
	},
};
const CG_LANE_NAMES = new Set(Object.values(CG_LANE_CONFIG).map((c) => c.name));

/**
 * Render a 1920×1080 PNG with a solid background and centered label. Used to
 * stand in for screen recordings / avatar renders / motion graphics until the
 * real footage lands. Each unique (label, bgColor) yields one media asset that
 * gets reused across every clip on that lane.
 */
async function generatePlaceholderPng({
	label,
	bgColor,
	fgColor = "#ffffff",
	width = 1920,
	height = 1080,
}: {
	label: string;
	bgColor: string;
	fgColor?: string;
	width?: number;
	height?: number;
}): Promise<File> {
	const canvas = document.createElement("canvas");
	canvas.width = width;
	canvas.height = height;
	const ctx = canvas.getContext("2d");
	if (!ctx) throw new Error("Canvas 2D context unavailable");
	ctx.fillStyle = bgColor;
	ctx.fillRect(0, 0, width, height);
	ctx.fillStyle = fgColor;
	ctx.font = "bold 140px 'Arial Black', Arial, sans-serif";
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillText(label, width / 2, height / 2);
	const blob: Blob = await new Promise((resolve, reject) => {
		canvas.toBlob(
			(b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))),
			"image/png",
		);
	});
	const slug = label.replace(/[^\w-]/g, "_").slice(0, 32) || "placeholder";
	return new File([blob], `placeholder_${slug}.png`, { type: "image/png" });
}

type LanePlan =
	| { kind: "existing"; trackId: string }
	| { kind: "rename"; trackId: string; renameCmd: RenameTrackCommand }
	| { kind: "new"; trackId: string; addCmd: AddTrackCommand };

function planCgLanes({
	scene,
	lanesUsed,
}: {
	scene: TScene;
	lanesUsed: Set<CgLane>;
}): Partial<Record<CgLane, LanePlan>> {
	const plan: Partial<Record<CgLane, LanePlan>> = {};
	const claimedIds = new Set<string>();
	// Resolve in declared order so each lane gets first pick of its legacy track.
	for (const lane of ["motion", "avatar", "diagrams", "screen"] as CgLane[]) {
		if (!lanesUsed.has(lane)) continue;
		const cfg = CG_LANE_CONFIG[lane];
		// Match exact name + type. Old text-typed placeholder tracks from the
		// prior deploy are intentionally NOT matched (different type) — the user
		// can delete those manually.
		const existing = scene.tracks.overlay.find(
			(t) => t.type === cfg.type && t.name === cfg.name,
		);
		if (existing) {
			plan[lane] = { kind: "existing", trackId: existing.id };
			claimedIds.add(existing.id);
			continue;
		}
		// Diagrams only: reuse the first unnamed legacy video track (covers
		// projects that had a generic overlay video pre-naming). All other
		// lanes always create fresh — claiming wrong-purpose tracks would
		// strand the user's earlier clips on a row labeled for something else.
		if (lane === "diagrams") {
			const legacy = scene.tracks.overlay.find(
				(t) =>
					t.type === cfg.type &&
					!claimedIds.has(t.id) &&
					!CG_LANE_NAMES.has(t.name),
			);
			if (legacy) {
				plan[lane] = {
					kind: "rename",
					trackId: legacy.id,
					renameCmd: new RenameTrackCommand(legacy.id, cfg.name),
				};
				claimedIds.add(legacy.id);
				continue;
			}
		}
		const addCmd = new AddTrackCommand(cfg.type, 0, cfg.name);
		plan[lane] = { kind: "new", trackId: addCmd.getTrackId(), addCmd };
	}
	return plan;
}

// Order commands so the final overlay stack ends up [motion, diagrams, screen]:
//   1. Renames first (no positional side-effects).
//   2. New AddTrackCommand inserts at index 0 in REVERSE stack order so the last
//      lane added (motion) lands on top.
/**
 * Tracks left over from the prior deploy when Motion Graphics / Screen were
 * TEXT-typed. Now that they're video-typed, those old tracks (with their
 * giant-fontSize text placeholders) are dead weight — wipe them on Apply.
 * Caveat: also nukes any manual text overlays the user put on those tracks.
 * Batched undo covers it if that ever bites.
 */
function detectStaleCgTracks(scene: TScene): string[] {
	const stale: string[] = [];
	for (const t of scene.tracks.overlay) {
		if (t.type === "text" && CG_LANE_NAMES.has(t.name)) {
			stale.push(t.id);
		}
	}
	return stale;
}

function emitCgLaneCommands(
	plan: Partial<Record<CgLane, LanePlan>>,
	staleTrackIds: string[] = [],
): Array<RemoveTrackCommand | RenameTrackCommand | AddTrackCommand> {
	const out: Array<RemoveTrackCommand | RenameTrackCommand | AddTrackCommand> =
		[];
	// Remove stale tracks first so subsequent inserts don't share space with them.
	for (const id of staleTrackIds) {
		out.push(new RemoveTrackCommand(id));
	}
	for (const lane of ["motion", "avatar", "diagrams", "screen"] as CgLane[]) {
		const p = plan[lane];
		if (p?.kind === "rename") out.push(p.renameCmd);
	}
	// Reverse stack order so the final overlay[0] is motion (top of stack).
	for (const lane of ["screen", "diagrams", "avatar", "motion"] as CgLane[]) {
		const p = plan[lane];
		if (p?.kind === "new") out.push(p.addCmd);
	}
	return out;
}


type VocalSegment = { name: string; char_start: number; char_end: number };

/**
 * Port of Flask's `_strip_and_segment`. Returns cleaned text (no === STEP ===
 * marker lines) plus segments whose char_start/end refer into `cleaned`.
 * Matches the same offset space the server's /visual-tags/apply uses.
 */
function parseVocalDoc(raw: string): { cleaned: string; segments: VocalSegment[] } {
	if (!raw) return { cleaned: "", segments: [] };
	const outLines: string[] = [];
	const rawSegs: Array<{ name: string; char_start: number; char_end: number | null }> = [];
	let joinedLen = 0;
	const pushSeg = (name: string, start: number) => {
		const last = rawSegs[rawSegs.length - 1];
		if (last && last.char_end == null) last.char_end = start;
		rawSegs.push({ name, char_start: start, char_end: null });
	};
	for (const line of raw.split("\n")) {
		const m = line.match(STEP_MARKER_RE);
		if (m) {
			const markerPos = joinedLen + (outLines.length ? 1 : 0);
			pushSeg(m[1].trim(), markerPos);
			continue;
		}
		const sep = outLines.length ? 1 : 0;
		outLines.push(line);
		joinedLen += sep + line.length;
	}
	const last = rawSegs[rawSegs.length - 1];
	if (last && last.char_end == null) last.char_end = joinedLen;

	let cleaned = outLines.join("\n");

	if (rawSegs.length === 0 || rawSegs[0].char_start > 0) {
		rawSegs.unshift({
			name: "INTRO",
			char_start: 0,
			char_end: rawSegs[0]?.char_start ?? cleaned.length,
		});
	}

	let segments = rawSegs
		.filter((s) => (s.char_end ?? 0) > s.char_start)
		.map((s) => ({ name: s.name, char_start: s.char_start, char_end: s.char_end as number }));

	const prefix = cleaned.length - cleaned.replace(/^\s+/, "").length;
	if (prefix > 0) {
		cleaned = cleaned.slice(prefix);
		segments = segments.map((s) => ({
			name: s.name,
			char_start: Math.max(0, s.char_start - prefix),
			char_end: Math.max(0, s.char_end - prefix),
		}));
	}
	cleaned = cleaned.replace(/\s+$/, "");
	const n = cleaned.length;
	segments = segments
		.map((s) => ({
			name: s.name,
			char_start: Math.min(s.char_start, n),
			char_end: Math.min(s.char_end, n),
		}))
		.filter((s) => s.char_end > s.char_start);

	return { cleaned, segments };
}

function makeTagId(): string {
	return "vt" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}

function VisualsTab({
	vid,
	projectId,
	fontSize,
}: {
	vid: string;
	projectId: string;
	fontSize: number;
}) {
	const editor = useEditor();
	const [rawDoc, setRawDoc] = useState<string>("");
	const [tags, setTags] = useState<VisualTag[]>([]);
	const [diagrams, setDiagrams] = useState<DiagramRow[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [placing, setPlacing] = useState(false);
	const selectionRef = useRef<{ char_start: number; char_end: number } | null>(null);
	const rightClickedTagRef = useRef<VisualTag | null>(null);
	const containerRef = useRef<HTMLDivElement | null>(null);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const { cleaned, segments: docSegments } = useMemo(
		() => parseVocalDoc(rawDoc),
		[rawDoc],
	);
	const [autoBusy, setAutoBusy] = useState(false);

	// Hydrate everything in parallel.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			setLoading(true);
			setError(null);
			try {
				const [vRes, tRes, dRes] = await Promise.all([
					fetch(`/api/videos/${vid}/vocal-doc`, { credentials: "include" }),
					fetch(`/api/videos/${vid}/visual-tags`, { credentials: "include" }),
					fetch(`/api/videos/${vid}/diagrams`, { credentials: "include" }),
				]);
				if (cancelled) return;
				if (vRes.ok) {
					const body = await vRes.json();
					setRawDoc(body.vocal_doc ?? "");
				}
				if (tRes.ok) {
					const body = await tRes.json();
					setTags(Array.isArray(body.tags) ? body.tags : []);
				}
				if (dRes.ok) {
					const body = await dRes.json();
					setDiagrams(Array.isArray(body) ? body : []);
				}
			} catch (e) {
				if (!cancelled) setError((e as Error).message);
			} finally {
				if (!cancelled) setLoading(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [vid]);

	// Debounced autosave of tags after any mutation.
	const persistTags = useCallback(
		(next: VisualTag[]) => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(async () => {
				try {
					await fetch(`/api/videos/${vid}/visual-tags`, {
						method: "POST",
						credentials: "include",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ tags: next }),
					});
				} catch {
					/* swallow — next mutation will retry */
				}
			}, 600);
		},
		[vid],
	);

	const setTagsAndSave = useCallback(
		(next: VisualTag[]) => {
			next.sort((a, b) => a.char_start - b.char_start || a.char_end - b.char_end);
			setTags(next);
			persistTags(next);
		},
		[persistTags],
	);

	// Build render segments: alternating tagged / untagged runs across `cleaned`.
	const segments = useMemo(() => {
		type Seg = { start: number; end: number; tag: VisualTag | null };
		if (!cleaned) return [] as Seg[];
		const sorted = [...tags]
			.filter((t) => t.char_end > t.char_start && t.char_start < cleaned.length)
			.map((t) => ({
				...t,
				char_start: Math.max(0, t.char_start),
				char_end: Math.min(cleaned.length, t.char_end),
			}))
			.sort((a, b) => a.char_start - b.char_start);
		const segs: Seg[] = [];
		let cursor = 0;
		for (const t of sorted) {
			if (t.char_start > cursor) {
				segs.push({ start: cursor, end: t.char_start, tag: null });
			}
			segs.push({ start: t.char_start, end: t.char_end, tag: t });
			cursor = Math.max(cursor, t.char_end);
		}
		if (cursor < cleaned.length) {
			segs.push({ start: cursor, end: cleaned.length, tag: null });
		}
		return segs;
	}, [cleaned, tags]);

	// Map a selection in the rendered DOM back to char offsets in `cleaned`.
	const captureSelection = useCallback(() => {
		const sel = typeof window !== "undefined" ? window.getSelection() : null;
		if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
			selectionRef.current = null;
			return;
		}
		const root = containerRef.current;
		if (!root) {
			selectionRef.current = null;
			return;
		}
		const resolve = (node: Node | null, offset: number): number | null => {
			if (!node) return null;
			let el: HTMLElement | null =
				node.nodeType === Node.ELEMENT_NODE
					? (node as HTMLElement)
					: (node.parentElement as HTMLElement | null);
			while (el && !el.hasAttribute("data-cs")) {
				if (el === root) return null;
				el = el.parentElement;
			}
			if (!el) return null;
			const cs = parseInt(el.getAttribute("data-cs") || "0", 10);
			return cs + offset;
		};
		const range = sel.getRangeAt(0);
		const a = resolve(range.startContainer, range.startOffset);
		const b = resolve(range.endContainer, range.endOffset);
		if (a == null || b == null) {
			selectionRef.current = null;
			return;
		}
		const cs = Math.min(a, b);
		const ce = Math.max(a, b);
		if (ce <= cs) {
			selectionRef.current = null;
			return;
		}
		selectionRef.current = { char_start: cs, char_end: ce };
	}, []);

	// When right-clicking inside an existing tag, surface it so "Clear tag" can act.
	const onContextMenu = useCallback(
		(e: React.MouseEvent) => {
			// Capture selection BEFORE the browser collapses on context-menu open.
			captureSelection();
			const target = e.target as HTMLElement;
			const tagSpan = target.closest("[data-tag-id]") as HTMLElement | null;
			if (tagSpan) {
				const id = tagSpan.getAttribute("data-tag-id");
				rightClickedTagRef.current = tags.find((t) => t.id === id) ?? null;
			} else {
				rightClickedTagRef.current = null;
			}
		},
		[captureSelection, tags],
	);

	const addTagFromSelection = useCallback(
		(type: VisualTagType, assetId?: string, label?: string) => {
			const sel = selectionRef.current;
			if (!sel) {
				toast.warning("Select some text first");
				return;
			}
			const next: VisualTag = {
				id: makeTagId(),
				char_start: sel.char_start,
				char_end: sel.char_end,
				type,
				asset_id: assetId,
				label,
			};
			// Replace any existing tags that overlap the new range.
			const survivors = tags.filter(
				(t) => t.char_end <= sel.char_start || t.char_start >= sel.char_end,
			);
			setTagsAndSave([...survivors, next]);
			// Clear OS selection so highlight is visible.
			window.getSelection()?.removeAllRanges();
			selectionRef.current = null;
			toast.success(`Tagged as ${TAG_STYLES[type].label}`);
		},
		[tags, setTagsAndSave],
	);

	const clearRightClickedTag = useCallback(() => {
		const t = rightClickedTagRef.current;
		if (!t) {
			toast.warning("Right-click inside a tag to clear it");
			return;
		}
		setTagsAndSave(tags.filter((x) => x.id !== t.id));
		rightClickedTagRef.current = null;
	}, [tags, setTagsAndSave]);

	const exportTags = useCallback(() => {
		const sortedTags = [...tags].sort(
			(a, b) => a.char_start - b.char_start || a.char_end - b.char_end,
		);
		const localCounts = sortedTags.reduce<Record<string, number>>((acc, t) => {
			acc[t.type] = (acc[t.type] || 0) + 1;
			return acc;
		}, {});
		const tagsWithSnippet = sortedTags.map((t) => {
			const ctxBefore = Math.max(0, t.char_start - 40);
			const ctxAfter = Math.min(cleaned.length, t.char_end + 40);
			return {
				...t,
				snippet: cleaned.slice(t.char_start, t.char_end),
				context: cleaned.slice(ctxBefore, ctxAfter),
				step:
					docSegments.find(
						(s) =>
							t.char_start >= s.char_start && t.char_end <= s.char_end,
					)?.name ?? "(none)",
			};
		});
		const dump = {
			exported_at: new Date().toISOString(),
			vid,
			tag_count: tags.length,
			counts: localCounts,
			cleaned_text_length: cleaned.length,
			diagrams: diagrams.map((d) => ({
				id: d.id,
				name: d.name,
				position: d.position,
				rendered: !!d.result_url,
			})),
			segments: docSegments.map((s) => ({
				name: s.name,
				char_start: s.char_start,
				char_end: s.char_end,
			})),
			tags: tagsWithSnippet,
		};
		const blob = new Blob([JSON.stringify(dump, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		const stamp = new Date()
			.toISOString()
			.replace(/[:T]/g, "-")
			.slice(0, 19);
		a.download = `visual-tags-${vid}-${stamp}.json`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
		toast.success(`Exported ${tags.length} tags`);
	}, [tags, cleaned, docSegments, vid, diagrams]);

	const runAutoVisuals = useCallback(async () => {
		setAutoBusy(true);
		try {
			const res = await fetch(`/api/videos/${vid}/visual-tags/auto-suggest`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ replace: true }),
			});
			const body = await res.json();
			if (!res.ok) {
				toast.error(body?.error || `Auto-tag failed (${res.status})`);
				return;
			}
			const newTags: VisualTag[] = Array.isArray(body.tags) ? body.tags : [];
			setTags(newTags);
			const count = body.suggested_count ?? 0;
			const counts: Record<string, number> = body.counts || {};
			const skipped: Array<{ name?: string; reason?: string }> =
				body.skipped || [];
			if (skipped.length) {
				console.group("[visual-tags/auto-suggest] skipped");
				console.table(skipped);
				console.groupEnd();
			}
			console.info("[visual-tags/auto-suggest] counts:", counts);
			const summary = (Object.entries(counts) as Array<[string, number]>)
				.filter(([, n]) => n > 0)
				.map(([k, n]) => `${k}:${n}`)
				.join(" ");
			if (count === 0) {
				toast.warning(
					skipped.length
						? `No tags suggested — ${skipped.length} skipped (see console)`
						: "No tags suggested",
				);
			} else {
				toast.success(
					`Tagged ${count}` +
						(summary ? ` (${summary})` : "") +
						(skipped.length ? ` • ${skipped.length} skipped (see console)` : ""),
				);
			}
		} catch (e) {
			toast.error(`Auto-tag failed: ${(e as Error).message}`);
		} finally {
			setAutoBusy(false);
		}
	}, [vid]);

	// Wipe every overlay track + every audio track. Use when the OPFS-side
	// media storage was lost (Assets tab empty) and existing clips reference
	// dead media — they need to go before the user re-imports audio/visuals.
	const resetTimeline = useCallback(() => {
		const ok = window.confirm(
			"Remove ALL overlay tracks and audio tracks?\n\n" +
				"This wipes clips on Motion/Avatar/Diagrams/Screen tracks and the voice audio. " +
				"You'll need to re-Apply visuals + re-Add audio to the timeline. Undoable with ⌘Z.",
		);
		if (!ok) return;
		const scene = editor.scenes.getActiveScene();
		const cmds: RemoveTrackCommand[] = [];
		for (const t of scene.tracks.overlay) cmds.push(new RemoveTrackCommand(t.id));
		for (const t of scene.tracks.audio) cmds.push(new RemoveTrackCommand(t.id));
		if (cmds.length === 0) {
			toast.info("Timeline already clean — nothing to remove");
			return;
		}
		editor.command.execute({ command: new BatchCommand(cmds) });
		toast.success(
			`Removed ${cmds.length} track${cmds.length === 1 ? "" : "s"}. ` +
				"Now: Voice → Add to Timeline, then Visuals → Apply to timeline.",
		);
	}, [editor]);

	const applyToTimeline = useCallback(async () => {
		if (!tags.length) {
			toast.error("No tags to apply yet");
			return;
		}
		setPlacing(true);
		try {
			const res = await fetch(`/api/videos/${vid}/visual-tags/apply`, {
				method: "POST",
				credentials: "include",
				headers: { "Content-Type": "application/json" },
			});
			const body = await res.json();
			if (!res.ok) {
				toast.error(body?.error || `Apply failed (${res.status})`);
				return;
			}
			type Placement = {
				tag_id: string;
				type: VisualTagType;
				matched: boolean;
				reason?: string;
				start: number;
				end: number;
				label?: string;
				result_url?: string;
				diagram_id?: string;
				diagram_name?: string;
			};
			const placements: Placement[] = body.placements || [];
			// All clips are uniform now — diagrams are real MP4s, everything else
			// is a colored placeholder PNG generated client-side. Both go on
			// video lanes via buildElementFromMedia.
			type PendingClip = {
				lane: CgLane;
				mediaId: string;
				mediaType: "image" | "video" | "audio";
				name: string;
				startTime: number;
				duration: number;
			};
			const pending: PendingClip[] = [];
			let skipped = 0;

			// Cache placeholder uploads by (bgColor, label) so 10 "🔖 CHAPTER 1"
			// tags share one media asset; only unique combos hit the canvas.
			const placeholderCache = new Map<string, Promise<string | null>>();
			const ensurePlaceholderMediaId = (
				label: string,
				bgColor: string,
			): Promise<string | null> => {
				const key = `${bgColor}::${label}`;
				let cached = placeholderCache.get(key);
				if (!cached) {
					cached = (async () => {
						try {
							const file = await generatePlaceholderPng({ label, bgColor });
							const processed = await processMediaAssets({ files: [file] });
							const asset = processed[0];
							if (!asset) return null;
							const saved = await editor.media.addMediaAsset({
								projectId,
								asset,
							});
							return saved?.id ?? null;
						} catch (err) {
							console.warn("[visual-tags] placeholder upload failed", err);
							return null;
						}
					})();
					placeholderCache.set(key, cached);
				}
				return cached;
			};

			const pushPlaceholder = async (
				lane: CgLane,
				label: string,
				bgColorOverride: string | undefined,
				startTime: number,
				duration: number,
			) => {
				const cfg = CG_LANE_CONFIG[lane];
				if (!cfg.placeholder) return false;
				const bgColor = bgColorOverride ?? cfg.placeholder.bgColor;
				const mediaId = await ensurePlaceholderMediaId(label, bgColor);
				if (!mediaId) return false;
				pending.push({
					lane,
					mediaId,
					mediaType: "image",
					name: label,
					startTime,
					duration,
				});
				return true;
			};

			for (const p of placements) {
				const startTime = Math.max(0, Math.round(p.start * TICKS_PER_SECOND));
				const durSec = Math.max(0.5, p.end - p.start);
				const duration = Math.round(durSec * TICKS_PER_SECOND);
				if (!p.matched) {
					skipped++;
					continue;
				}
				if (p.type === "diagram" && p.result_url) {
					try {
						const r = await fetch(p.result_url, { credentials: "include" });
						if (!r.ok) {
							skipped++;
							continue;
						}
						const blob = await r.blob();
						const mime = blob.type || "video/mp4";
						const ext = (mime.split("/")[1] || "mp4").replace(/[^a-z0-9]/gi, "");
						const file = new File(
							[blob],
							`diagram_${p.diagram_id ?? p.tag_id}.${ext}`,
							{ type: mime },
						);
						const processed = await processMediaAssets({ files: [file] });
						for (const asset of processed) {
							const saved = await editor.media.addMediaAsset({ projectId, asset });
							if (!saved) {
								skipped++;
								continue;
							}
							pending.push({
								lane: "diagrams",
								mediaId: saved.id,
								mediaType: saved.type,
								name: p.diagram_name || "Diagram",
								startTime,
								duration,
							});
						}
					} catch (err) {
						console.warn("[visual-tags] diagram import failed", err);
						skipped++;
					}
				} else if (p.type === "screen") {
					const ok = await pushPlaceholder(
						"screen",
						"📺 SCREEN",
						undefined,
						startTime,
						duration,
					);
					if (!ok) skipped++;
				} else if (p.type === "text_anim") {
					const ok = await pushPlaceholder(
						"motion",
						p.label || "✨ TEXT",
						"#8d6e00",
						startTime,
						duration,
					);
					if (!ok) skipped++;
				} else if (p.type === "chapters") {
					const ok = await pushPlaceholder(
						"motion",
						"📚 CHAPTERS",
						"#3a7d5e",
						startTime,
						duration,
					);
					if (!ok) skipped++;
				} else if (p.type === "chapter") {
					const ok = await pushPlaceholder(
						"motion",
						p.label || "🔖 CHAPTER",
						"#b45c1a",
						startTime,
						duration,
					);
					if (!ok) skipped++;
				} else if (p.type === "avatar") {
					const ok = await pushPlaceholder(
						"avatar",
						"🧑 AVATAR",
						undefined,
						startTime,
						duration,
					);
					if (!ok) skipped++;
				}
			}
			if (pending.length === 0) {
				toast.warning(
					skipped > 0
						? `Nothing placed — ${skipped} tag(s) couldn't resolve`
						: "Nothing to place",
				);
				return;
			}
			const scene = editor.scenes.getActiveScene();
			const lanesUsed = new Set<CgLane>(pending.map((p) => p.lane));
			const lanePlan = planCgLanes({ scene, lanesUsed });
			const cmds: Array<
				| AddTrackCommand
				| RemoveTrackCommand
				| RenameTrackCommand
				| InsertElementCommand
			> = [...emitCgLaneCommands(lanePlan, detectStaleCgTracks(scene))];
			for (const p of pending) {
				const trackId = lanePlan[p.lane]?.trackId;
				if (!trackId) continue;
				cmds.push(
					new InsertElementCommand({
						element: buildElementFromMedia({
							mediaId: p.mediaId,
							mediaType: p.mediaType,
							name: p.name,
							duration: p.duration,
							startTime: p.startTime,
						}),
						placement: { mode: "explicit", trackId },
					}),
				);
			}
			editor.command.execute({ command: new BatchCommand(cmds) });
			const placedCount = pending.length;
			toast.success(
				`Placed ${placedCount} clip${placedCount === 1 ? "" : "s"}` +
					(skipped ? ` • ${skipped} skipped (see console)` : "") +
					(body.method === "estimate-13cps"
						? " (timing estimated — synth audio for precision)"
						: ""),
			);
			if (skipped) {
				console.warn(
					"[visual-tags] skipped:",
					placements.filter((p) => !p.matched),
				);
			}
		} catch (e) {
			toast.error(`Apply failed: ${(e as Error).message}`);
		} finally {
			setPlacing(false);
		}
	}, [editor, projectId, tags.length, vid]);

	if (loading) {
		return (
			<div className="text-muted-foreground flex h-full items-center justify-center text-xs">
				Loading…
			</div>
		);
	}
	if (error) {
		return (
			<div className="text-destructive flex h-full items-center justify-center text-xs">
				{error}
			</div>
		);
	}
	if (!cleaned) {
		return (
			<EmptyState message="Say doc is empty — generate it from the Say tab first." />
		);
	}

	const tagCount = tags.length;
	const counts = tags.reduce<Record<string, number>>((acc, t) => {
		acc[t.type] = (acc[t.type] || 0) + 1;
		return acc;
	}, {});

	return (
		<div className="flex h-full flex-col">
			<div className="border-b flex items-center justify-between gap-2 px-3 py-1.5">
				<div className="text-muted-foreground flex items-center gap-2 text-[11px]">
					<span>{tagCount} tag{tagCount === 1 ? "" : "s"}</span>
					{(Object.keys(TAG_STYLES) as VisualTagType[]).map((k) =>
						counts[k] ? (
							<span
								key={k}
								className="rounded px-1.5 py-0.5"
								style={{
									backgroundColor: TAG_STYLES[k].bg,
									color: TAG_STYLES[k].fg,
								}}
							>
								{TAG_STYLES[k].label} × {counts[k]}
							</span>
						) : null,
					)}
				</div>
				<div className="flex items-center gap-1.5">
					<button
						type="button"
						onClick={exportTags}
						disabled={tagCount === 0}
						title="Download current tags + script snippets as JSON for diff/comparison"
						className={cn(
							"text-muted-foreground hover:text-foreground rounded px-2 py-1 text-xs",
							"disabled:opacity-50 disabled:cursor-not-allowed",
						)}
					>
						Export tags
					</button>
					<button
						type="button"
						onClick={runAutoVisuals}
						disabled={autoBusy || placing || diagrams.length === 0}
						title="Auto-tag one diagram per step at the start of that step's body"
						className={cn(
							"text-muted-foreground hover:text-foreground rounded px-2 py-1 text-xs",
							"disabled:opacity-50 disabled:cursor-not-allowed",
							autoBusy && "animate-pulse",
						)}
					>
						{autoBusy ? "Tagging…" : "Auto visuals"}
					</button>
					<button
						type="button"
						onClick={resetTimeline}
						disabled={placing}
						title="Remove ALL overlay tracks + audio tracks. Use when media is missing (Assets tab is empty) and you need to rebuild from Voice + Visuals."
						className={cn(
							"text-muted-foreground hover:text-destructive rounded px-2 py-1 text-xs",
							"disabled:opacity-50 disabled:cursor-not-allowed",
						)}
					>
						Reset clips
					</button>
					<button
						type="button"
						onClick={applyToTimeline}
						disabled={placing || tagCount === 0}
						className={cn(
							"bg-foreground text-background rounded px-2.5 py-1 text-xs font-medium hover:opacity-90",
							"disabled:opacity-50 disabled:cursor-not-allowed",
							placing && "animate-pulse",
						)}
					>
						{placing ? "Placing…" : "Apply to timeline"}
					</button>
				</div>
			</div>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					<div
						ref={containerRef}
						onMouseUp={captureSelection}
						onContextMenu={onContextMenu}
						className="flex-1 min-h-0 w-full overflow-y-auto px-4 py-3 whitespace-pre-wrap break-words text-foreground select-text"
						style={{
							fontSize: `${fontSize}px`,
							lineHeight: 1.7,
							fontFamily: "Helvetica Neue, Helvetica, Arial, sans-serif",
						}}
					>
						{(docSegments.length > 0 ? docSegments : [{ name: "", char_start: 0, char_end: cleaned.length }]).map(
							(stepSeg, segIdx) => {
								// Sub-segments inside this step: alternating tagged/untagged.
								const inStep = tags
									.filter(
										(t) =>
											t.char_end > stepSeg.char_start &&
											t.char_start < stepSeg.char_end,
									)
									.map((t) => ({
										...t,
										char_start: Math.max(t.char_start, stepSeg.char_start),
										char_end: Math.min(t.char_end, stepSeg.char_end),
									}))
									.sort((a, b) => a.char_start - b.char_start);
								const subs: Array<{
									start: number;
									end: number;
									tag: VisualTag | null;
								}> = [];
								let cursor = stepSeg.char_start;
								for (const t of inStep) {
									if (t.char_start > cursor)
										subs.push({ start: cursor, end: t.char_start, tag: null });
									subs.push({ start: t.char_start, end: t.char_end, tag: t });
									cursor = Math.max(cursor, t.char_end);
								}
								if (cursor < stepSeg.char_end)
									subs.push({ start: cursor, end: stepSeg.char_end, tag: null });
								const showHeader =
									stepSeg.name &&
									stepSeg.name.toUpperCase() !== "INTRO" &&
									docSegments.length > 0;
								return (
									<Fragment key={`step-${segIdx}`}>
										{showHeader && (
											<div
												contentEditable={false}
												className="my-3 select-none"
												style={{
													userSelect: "none",
													color: "#9ca3af",
													fontWeight: 500,
												}}
											>
												{`=== ${stepSeg.name} ===`}
											</div>
										)}
										{subs.map((s, idx) => {
											const text = cleaned.slice(s.start, s.end);
											if (s.tag) {
												const style = TAG_STYLES[s.tag.type];
												return (
													<span
														key={`${s.start}-${idx}`}
														data-cs={s.start}
														data-tag-id={s.tag.id}
														title={`${style.label}${s.tag.label ? ` — ${s.tag.label}` : ""}`}
														style={{
															backgroundColor: style.bg,
															borderBottom: `2px solid ${style.fg}`,
															padding: "0 2px",
															borderRadius: 2,
														}}
													>
														{text}
													</span>
												);
											}
											return (
												<span key={`${s.start}-${idx}`} data-cs={s.start}>
													{text}
												</span>
											);
										})}
									</Fragment>
								);
							},
						)}
					</div>
				</ContextMenuTrigger>
				<ContextMenuContent className="w-56">
					<ContextMenuSub>
						<ContextMenuSubTrigger>Diagram</ContextMenuSubTrigger>
						<ContextMenuSubContent className="max-h-72 w-56 overflow-y-auto">
							{diagrams.length === 0 ? (
								<ContextMenuItem disabled>
									No diagrams yet
								</ContextMenuItem>
							) : (
								diagrams.map((d) => (
									<ContextMenuItem
										key={d.id}
										onSelect={() =>
											addTagFromSelection("diagram", d.id, d.name)
										}
									>
										{d.name}
									</ContextMenuItem>
								))
							)}
						</ContextMenuSubContent>
					</ContextMenuSub>
					<ContextMenuItem onSelect={() => addTagFromSelection("avatar")}>
						Avatar
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => addTagFromSelection("text_anim")}>
						Text animation
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => addTagFromSelection("screen")}>
						Screen recording
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => addTagFromSelection("chapter")}>
						Chapter
					</ContextMenuItem>
					<ContextMenuSeparator />
					<ContextMenuItem
						variant="destructive"
						onSelect={clearRightClickedTag}
					>
						Clear tag (right-click inside one)
					</ContextMenuItem>
				</ContextMenuContent>
			</ContextMenu>
		</div>
	);
}

function DiagramPreview({
	diagram,
	diagrams,
	onNavigate,
	onClose,
	onUpdated,
	onDeleted,
}: {
	diagram: DiagramRow;
	diagrams: DiagramRow[];
	onNavigate: (id: string) => void;
	onClose: () => void;
	onUpdated: (d: DiagramRow) => void;
	onDeleted: (id: string) => void;
}) {
	const [busy, setBusy] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);

	const currentIdx = diagrams.findIndex((d) => d.id === diagram.id);
	const prevDiagram =
		currentIdx > 0 ? diagrams[currentIdx - 1] : null;
	const nextDiagram =
		currentIdx >= 0 && currentIdx < diagrams.length - 1
			? diagrams[currentIdx + 1]
			: null;

	const deleteDiagram = async () => {
		setBusy(true);
		try {
			const res = await fetch(`/api/diagrams/${diagram.id}`, {
				method: "DELETE",
				credentials: "include",
			});
			if (!res.ok) {
				const body = await res.json().catch(() => ({}));
				toast.error(body?.error || `Delete failed (${res.status})`);
				return;
			}
			toast.success(`Deleted "${diagram.name}"`);
			onDeleted(diagram.id);
			onClose();
		} catch (e) {
			toast.error(`Delete failed: ${(e as Error).message}`);
		} finally {
			setBusy(false);
		}
	};
	const imgUrl =
		diagram.image_path_url ||
		diagram.result_url ||
		null;

	const transformPixelArt = async () => {
		setBusy(true);
		try {
			const res = await fetch(`/api/diagrams/${diagram.id}/pixel-art`, {
				method: "POST",
				credentials: "include",
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				toast.error(body?.error || `Pixel art failed (${res.status})`);
				return;
			}
			toast.success("Pixel art generated");
			onUpdated(body);
		} catch (e) {
			toast.error(`Pixel art failed: ${(e as Error).message}`);
		} finally {
			setBusy(false);
		}
	};

	const regenerate = async () => {
		setBusy(true);
		try {
			const res = await fetch(`/api/diagrams/${diagram.id}/regenerate`, {
				method: "POST",
				credentials: "include",
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				toast.error(body?.error || `Regenerate failed (${res.status})`);
				return;
			}
			toast.success("Diagram regenerated");
			onUpdated(body);
		} catch (e) {
			toast.error(`Regenerate failed: ${(e as Error).message}`);
		} finally {
			setBusy(false);
		}
	};

	// ESC closes, ← / → flip between diagrams
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (busy) return;
			if (e.key === "Escape") onClose();
			else if (e.key === "ArrowLeft" && prevDiagram) onNavigate(prevDiagram.id);
			else if (e.key === "ArrowRight" && nextDiagram) onNavigate(nextDiagram.id);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose, onNavigate, busy, prevDiagram, nextDiagram]);

	// Cache-bust the image URL after a transform so the new file shows
	const cacheBustedUrl = imgUrl
		? `${imgUrl}${imgUrl.includes("?") ? "&" : "?"}t=${diagram.updated_at ?? ""}`
		: null;

	return (
		<div
			className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 backdrop-blur-sm p-6"
			onClick={busy ? undefined : onClose}
		>
			<div
				className="bg-background flex h-[92vh] w-[92vw] max-w-[1800px] flex-col overflow-hidden rounded-md border shadow-2xl"
				onClick={(e) => e.stopPropagation()}
			>
				<div className="border-b flex items-center justify-between gap-2 px-3 py-2">
					<div className="flex items-center gap-2 min-w-0">
						<button
							type="button"
							onClick={() => prevDiagram && onNavigate(prevDiagram.id)}
							disabled={busy || !prevDiagram}
							aria-label="Previous diagram"
							title={prevDiagram ? `← ${prevDiagram.name}` : "First diagram"}
							className="text-muted-foreground hover:text-foreground rounded p-1 disabled:opacity-30 disabled:cursor-not-allowed"
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
						</button>
						<div className="text-foreground truncate text-sm font-medium">
							{diagram.name}
						</div>
						<button
							type="button"
							onClick={() => nextDiagram && onNavigate(nextDiagram.id)}
							disabled={busy || !nextDiagram}
							aria-label="Next diagram"
							title={nextDiagram ? `→ ${nextDiagram.name}` : "Last diagram"}
							className="text-muted-foreground hover:text-foreground rounded p-1 disabled:opacity-30 disabled:cursor-not-allowed"
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="m9 18 6-6-6-6" /></svg>
						</button>
						{diagrams.length > 1 && currentIdx >= 0 && (
							<span className="text-muted-foreground text-[11px] tabular-nums">
								{currentIdx + 1} / {diagrams.length}
							</span>
						)}
					</div>
					<button
						type="button"
						onClick={onClose}
						disabled={busy}
						className="text-muted-foreground hover:text-foreground text-xs disabled:opacity-50"
					>
						Close (esc)
					</button>
				</div>
				<div className="bg-muted/20 flex flex-1 min-h-0 items-center justify-center overflow-auto p-3">
					{cacheBustedUrl ? (
						<img
							src={cacheBustedUrl}
							alt={diagram.name}
							className="max-h-full max-w-full rounded object-contain"
						/>
					) : (
						<div className="text-muted-foreground text-sm">
							No image attached to this diagram.
						</div>
					)}
				</div>
				<div className="border-t flex items-center justify-between gap-2 px-3 py-2">
					<div className="flex items-center gap-2">
						{confirmDelete ? (
							<>
								<span className="text-[11px] text-red-500">Delete?</span>
								<button
									type="button"
									onClick={deleteDiagram}
									disabled={busy}
									className="bg-red-600 text-white rounded px-2.5 py-1 text-xs font-medium hover:bg-red-700 disabled:opacity-50"
								>
									{busy ? "Deleting…" : "Yes, delete"}
								</button>
								<button
									type="button"
									onClick={() => setConfirmDelete(false)}
									disabled={busy}
									className="text-muted-foreground hover:text-foreground text-xs disabled:opacity-50"
								>
									Cancel
								</button>
							</>
						) : (
							<button
								type="button"
								onClick={() => setConfirmDelete(true)}
								disabled={busy}
								className="text-red-500/80 hover:text-red-500 text-xs disabled:opacity-50"
							>
								Delete
							</button>
						)}
					</div>
					<div className="flex items-center gap-1.5">
						<button
							type="button"
							onClick={regenerate}
							disabled={busy}
							className={cn(
								"text-muted-foreground hover:text-foreground rounded px-2.5 py-1 text-xs disabled:opacity-50 disabled:cursor-not-allowed",
								busy && "animate-pulse",
							)}
						>
							{busy ? "Working…" : "↻ Regenerate"}
						</button>
						<button
							type="button"
							onClick={transformPixelArt}
							disabled={busy || !imgUrl}
							className={cn(
								"bg-foreground text-background rounded px-3 py-1 text-xs font-medium hover:opacity-90",
								"disabled:opacity-50 disabled:cursor-not-allowed",
								busy && "animate-pulse",
							)}
						>
							{busy ? "Working…" : "→ Pixel Art"}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

function DiagramCard({
	diagram,
	onClick,
	onDelete,
}: {
	diagram: DiagramRow;
	onClick?: () => void;
	onDelete?: () => void;
}) {
	const thumb = diagram.image_path_url || null;
	const hasRender = !!diagram.result_url;
	const duration = diagram.result_meta?.duration;
	// Cache-bust by updated_at so a fresh pixel-art version actually paints
	const thumbSrc = thumb
		? `${thumb}${thumb.includes("?") ? "&" : "?"}t=${diagram.updated_at ?? ""}`
		: null;
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<div className="group relative mb-1">
					<button
						type="button"
						onClick={onClick}
						className="hover:bg-accent/40 flex w-full items-center gap-3 rounded p-2 text-left transition-colors"
					>
						<div className="bg-muted relative h-12 w-20 shrink-0 overflow-hidden rounded">
							{thumbSrc ? (
								<img
									src={thumbSrc}
									alt={diagram.name}
									className="size-full object-cover"
								/>
							) : (
								<div className="text-muted-foreground flex size-full items-center justify-center text-[10px]">
									no image
								</div>
							)}
						</div>
						<div className="min-w-0 flex-1 pr-7">
							<div className="text-foreground truncate text-xs font-medium">
								{diagram.name}
							</div>
							<div className="text-muted-foreground flex items-center gap-1.5 text-[10px]">
								<span
									className={cn(
										"inline-block size-1.5 rounded-full",
										hasRender ? "bg-green-500" : "bg-amber-500",
									)}
								/>
								<span>{hasRender ? "Rendered" : "Draft"}</span>
								{typeof duration === "number" && duration > 0 && (
									<>
										<span>·</span>
										<span>{duration.toFixed(1)}s</span>
									</>
								)}
							</div>
						</div>
					</button>
					{onDelete && (
						<button
							type="button"
							onClick={(e) => {
								e.stopPropagation();
								onDelete();
							}}
							aria-label="Delete diagram"
							className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-1 text-muted-foreground/0 group-hover:text-muted-foreground hover:bg-red-500/10 hover:text-red-500 transition-colors"
						>
							<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
								<path d="M3 6h18" />
								<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
								<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
							</svg>
						</button>
					)}
				</div>
			</ContextMenuTrigger>
			{onDelete && (
				<ContextMenuContent>
					<ContextMenuItem
						variant="destructive"
						onClick={onDelete}
					>
						Delete
					</ContextMenuItem>
				</ContextMenuContent>
			)}
		</ContextMenu>
	);
}

function SynthMeter({
	stats,
	maxWordsInput,
	onMaxWordsChange,
}: {
	stats: {
		total: number;
		sliceCount: number;
		chars: number;
		isAll: boolean;
	};
	maxWordsInput: string;
	onMaxWordsChange: (v: string) => void;
}) {
	const { total, sliceCount, chars, isAll } = stats;
	const pctCreator = chars
		? ((chars / EL_QUOTA_CREATOR) * 100).toFixed(2)
		: "0.00";
	const pctPro = chars ? ((chars / EL_QUOTA_PRO) * 100).toFixed(2) : "0.00";
	const overage = chars
		? ((chars / 1000) * EL_OVERAGE_PER_1K_CHARS).toFixed(2)
		: "0.00";

	return (
		<div className="border-b bg-muted/30 flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-1.5 text-[11px] text-muted-foreground">
			<label className="flex items-center gap-1.5">
				<span>Max words</span>
				<input
					type="text"
					inputMode="numeric"
					pattern="[0-9]*"
					value={maxWordsInput}
					placeholder="All"
					onChange={(e) => onMaxWordsChange(e.target.value)}
					className="w-16 rounded border bg-background px-1.5 py-0.5 text-center text-foreground outline-none focus:ring-1 focus:ring-foreground/30"
				/>
			</label>
			{total > 0 ? (
				<span className="text-foreground/80">
					{isAll
						? `Sending all ${total.toLocaleString()} words`
						: `Sending ${sliceCount.toLocaleString()} of ${total.toLocaleString()} words`}
				</span>
			) : (
				<span>No SAY text yet</span>
			)}
			{chars > 0 && (
				<>
					<span>·</span>
					<span>
						<span className="text-foreground/80">
							{chars.toLocaleString()} chars
						</span>
					</span>
					<span>·</span>
					<span>{pctCreator}% of Creator</span>
					<span>·</span>
					<span>{pctPro}% of Pro</span>
					<span>·</span>
					<span title="Pay-as-you-go: $0.15 per 1k chars">~${overage} PAYG</span>
				</>
			)}
		</div>
	);
}

function SaveBadge({ status }: { status: SaveStatus }) {
	if (status === "idle") return <span className="w-12" />;
	const label =
		status === "saving"
			? "Saving…"
			: status === "saved"
				? "Saved"
				: "Save failed";
	const color =
		status === "saving"
			? "text-muted-foreground"
			: status === "saved"
				? "text-green-500"
				: "text-red-500";
	return (
		<span className={cn("w-16 text-right text-[11px]", color)}>{label}</span>
	);
}

function EmptyState({ message }: { message: string }) {
	return (
		<div className="text-muted-foreground flex h-full items-center justify-center px-6 text-center text-sm">
			{message}
		</div>
	);
}
