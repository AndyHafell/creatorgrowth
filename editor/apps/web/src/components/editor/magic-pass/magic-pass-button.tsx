"use client";

// Magic AutoPass v2 (Agent 12) — one click camera-directs the timeline:
// Raw Cut transcript (OPFS cache) → timeline-mapped words → heuristic shot
// list with FULL coverage (reframe resting states between zoom/highlight
// beats) → frames sampled across the scope → /api/magic-pass Gemini vision
// DIRECTOR writes the final shot list → ordinary editable EffectElements in a
// single undo batch. Re-runs are idempotent: existing "Magic: " clips inside
// the scope are deleted in the same batch. Scope defaults to the first two
// minutes for fast iteration; the chevron menu switches to the full video.

import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, MousePointerClick, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuCheckboxItem,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { EditorCore } from "@/core";
import { useEditor } from "@/hooks/use-editor";
import { TICKS_PER_SECOND } from "@/lib/wasm";
import { buildEffectElement } from "@/lib/timeline/element-utils";
import {
	DeleteElementsCommand,
	InsertElementCommand,
} from "@/lib/commands/timeline";
import { BatchCommand, type Command } from "@/lib/commands";
import type { TimelineElement, VideoElement } from "@/lib/timeline/types";
import { computeFileHash } from "@/lib/raw-cut/transcription-cache";
import { geminiHeaders, getStoredKey } from "@/lib/final-pass/api-keys";
import {
	pickTranscript,
	type TranscriptEntry,
} from "@/lib/magic-pass/pick-transcript";
import {
	mapWordsToTimeline,
	timelineSecToMediaSec,
	type ElementWindow,
} from "@/lib/magic-pass/timeline-map";
import {
	mergeAdjacentReframes,
	splitScopeIntoChunks,
} from "@/lib/magic-pass/chunking";
import { clampBrowserChrome } from "@/lib/magic-pass/chrome-clamp";
import {
	cursorBeatCandidates,
	cursorHintLines,
	detectCursorDwells,
	parseCursorLog,
	rankAndSpaceDwells,
} from "@/lib/magic-pass/cursor-beats";
import { detectBeats, detectBoundaries } from "@/lib/magic-pass/heuristics";
import { planClipToElementSpec } from "@/lib/magic-pass/plan";
import {
	buildShotList,
	directorFrameTimes,
	sanitizeShotList,
	wordsToTranscriptLines,
} from "@/lib/magic-pass/shot-list";
import {
	MAX_REFINE_FRAMES,
	type BeatCandidate,
	type MagicPlan,
	type MagicPlanClip,
	type TimelineWord,
} from "@/lib/magic-pass/types";
import { readCursorLog, writeCursorLog } from "./cursor-log-store";
import { sampleFrames } from "./sample-frames";
import { readAllCachedTranscriptions } from "./transcript-store";

type MagicScope = "2min" | "full";

const SCOPE_SEC: Record<MagicScope, number> = { "2min": 120, full: Infinity };

// Transcript words are media-time; whisper cache entries lack words, so
// segments degrade into evenly-spread pseudo-words (good enough for phrase
// detection — timings stay within the segment).
function transcriptToWords(cache: TranscriptEntry): TimelineWord[] {
	if (cache.words && cache.words.length > 0) return cache.words;
	const out: TimelineWord[] = [];
	for (const seg of cache.segments) {
		const tokens = seg.text.split(/\s+/).filter(Boolean);
		if (tokens.length === 0) continue;
		const step = (seg.end - seg.start) / tokens.length;
		tokens.forEach((text, i) => {
			out.push({
				text,
				start: seg.start + i * step,
				end: seg.start + (i + 1) * step,
			});
		});
	}
	return out;
}

async function loadTranscript({
	file,
	mediaDurationSec,
}: {
	file: File | Blob;
	mediaDurationSec: number | null;
}): Promise<{
	entry: TranscriptEntry | null;
	scanned: number;
	contentHash: string;
}> {
	const contentHash = await computeFileHash(file);
	const entries = await readAllCachedTranscriptions();
	return {
		entry: pickTranscript({ entries, contentHash, mediaDurationSec }),
		scanned: entries.length,
		contentHash,
	};
}

/**
 * The raw-cut media: video elements anywhere on the timeline — the Raw Cut
 * page sends clips to an overlay "Raw Cut" track and leaves main empty, so
 * scan overlay tracks AND main. The dominant mediaId (most timeline duration)
 * is the clip being directed. Shared by the run itself and "Attach cursor
 * log…" (the log is keyed by this media's content hash).
 */
function findRawCutMedia(editor: EditorCore):
	| {
			asset: { file: File | Blob; duration?: number };
			elements: ElementWindow[];
			durationSec: number;
	  }
	| { error: string } {
	const scene = editor.scenes.getActiveScene();
	const videoEls = [...scene.tracks.overlay, scene.tracks.main]
		.flatMap((track): TimelineElement[] => [...track.elements])
		.filter((el): el is VideoElement => el.type === "video");
	if (videoEls.length === 0) {
		return { error: "No video elements found on the timeline." };
	}
	const durByMedia = new Map<string, number>();
	for (const el of videoEls) {
		durByMedia.set(
			el.mediaId,
			(durByMedia.get(el.mediaId) ?? 0) + el.duration,
		);
	}
	const mediaId = [...durByMedia.entries()].sort((a, b) => b[1] - a[1])[0][0];
	const asset = editor.media.getAssets().find((a) => a.id === mediaId);
	if (!asset?.file) {
		return { error: "Couldn't access the clip's media file." };
	}
	const elements: ElementWindow[] = videoEls
		.filter((el) => el.mediaId === mediaId)
		.map((el) => ({
			startTime: el.startTime,
			trimStart: el.trimStart,
			trimEnd: el.trimEnd,
			duration: el.duration,
		}));
	const durationSec =
		Math.max(...elements.map((el) => el.startTime + el.duration)) /
		TICKS_PER_SECOND;
	return { asset: { file: asset.file, duration: asset.duration }, elements, durationSec };
}

export function MagicPassButton() {
	const editor = useEditor();
	const [stage, setStage] = useState<string | null>(null);
	const [scope, setScope] = useState<MagicScope>("2min");
	// Punches-only: the director still plans full coverage (context makes its
	// zoom picks better), but only zoom/highlight clips get inserted — Andy:
	// "the reframe is quite wrong the majority of the time".
	const [punchesOnly, setPunchesOnly] = useState(false);
	const cursorFileRef = useRef<HTMLInputElement>(null);

	const run = useCallback(async () => {
		if (stage) return;
		try {
			const found = findRawCutMedia(editor);
			if ("error" in found) {
				toast.error(found.error);
				return;
			}
			const { asset, elements, durationSec } = found;
			const scopeEnd = Math.min(durationSec, SCOPE_SEC[scope]);

			// 2. Transcript from the Raw Cut OPFS cache.
			setStage("Reading transcript…");
			const mediaDurationSec =
				asset.duration ??
				Math.max(...elements.map((el) => el.trimStart + el.duration)) /
					TICKS_PER_SECOND;
			const {
				entry: cache,
				scanned,
				contentHash,
			} = await loadTranscript({
				file: asset.file,
				mediaDurationSec,
			});
			if (!cache) {
				toast.error(
					`No transcript matched this clip (${scanned} cached) — run Transcribe in Raw Cut first, then try again.`,
				);
				return;
			}
			const timelineWords = mapWordsToTimeline({
				words: transcriptToWords(cache),
				elements,
				ticksPerSecond: TICKS_PER_SECOND,
			});

			// 2b. Cursor beats from an attached sidecar log (v4) — exact dwell
			// positions become extra zoom candidates + director focal hints.
			// No log attached = empty arrays = v3 behavior exactly.
			const cursorSamples = await readCursorLog(contentHash);
			let cursorCands: BeatCandidate[] = [];
			if (cursorSamples && cursorSamples.length >= 2) {
				cursorCands = cursorBeatCandidates({
					dwells: rankAndSpaceDwells(detectCursorDwells(cursorSamples)),
					elements,
					ticksPerSecond: TICKS_PER_SECOND,
				});
			}

			// 3. Chunk the scope (~2-minute windows): each chunk gets its own
			// heuristic fallback and full frame density — one director call per
			// chunk keeps a 13-minute video as sharply directed as a 2-minute one.
			setStage("Building shot list…");
			const beats = [
				...detectBeats({ words: timelineWords }),
				...cursorCands,
			].sort((a, b) => a.triggerStart - b.triggerStart);
			const boundaries = detectBoundaries({ words: timelineWords });
			const chunks = splitScopeIntoChunks({
				scopeStart: 0,
				scopeEnd,
				boundaries,
			});
			if (chunks.length === 0) {
				toast.error("Scope window is empty — nothing to lay out.");
				return;
			}
			const heuristicFor = (chunk: { start: number; end: number }) =>
				buildShotList({
					beats,
					boundaries,
					scopeStart: chunk.start,
					scopeEnd: chunk.end,
				});

			// 4. Vision director (skipped without a Gemini key), one sequential
			// call per chunk with continuity context. A failed chunk falls back
			// to its heuristic shot list — never the whole run.
			const directedClips: MagicPlanClip[] = [];
			let refined = false;
			let note: string | undefined;
			if (getStoredKey("gemini")) {
				setStage("Sampling frames…");
				const times = chunks
					.flatMap((chunk) =>
						directorFrameTimes({
							scopeStart: chunk.start,
							scopeEnd: chunk.end,
							maxFrames: MAX_REFINE_FRAMES,
						}),
					)
					.map((timelineSec) => {
						const mediaSec = timelineSecToMediaSec({
							timelineSec,
							elements,
							ticksPerSecond: TICKS_PER_SECOND,
						});
						return mediaSec === null ? null : { timelineSec, mediaSec };
					})
					.filter(
						(t): t is { timelineSec: number; mediaSec: number } => t !== null,
					);
				const frames = await sampleFrames({ file: asset.file, times });

				const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
				let fallbackChunks = 0;
				for (let i = 0; i < chunks.length; i++) {
					const chunk = chunks[i];
					setStage(
						chunks.length > 1
							? `Directing ${i + 1}/${chunks.length}…`
							: "AI directing…",
					);
					const chunkPlan = heuristicFor(chunk);
					const chunkFrames = frames.filter(
						(f) => f.timeSec >= chunk.start && f.timeSec < chunk.end,
					);
					let chunkClips = chunkPlan.clips;
					try {
						const res = await fetch(`${base}/api/magic-pass`, {
							method: "POST",
							headers: {
								"content-type": "application/json",
								...geminiHeaders(),
							},
							body: JSON.stringify({
								plan: chunkPlan,
								transcriptLines: wordsToTranscriptLines({
									words: timelineWords,
									scopeStart: chunk.start,
									scopeEnd: chunk.end,
								}),
								scope: { start: chunk.start, end: chunk.end },
								durationSec,
								frames: chunkFrames,
								previousClip: directedClips[directedClips.length - 1] ?? null,
								cursorHints: cursorHintLines({
									candidates: cursorCands,
									scopeStart: chunk.start,
									scopeEnd: chunk.end,
								}),
							}),
						});
						if (res.ok) {
							const data = (await res.json()) as {
								plan: MagicPlan;
								refined: boolean;
								note?: string;
							};
							if (data.refined) {
								refined = true;
								chunkClips = data.plan.clips;
							} else {
								fallbackChunks += 1;
								if (data.note) note = data.note;
							}
						} else {
							fallbackChunks += 1;
							note = `director HTTP ${res.status}`;
						}
					} catch {
						fallbackChunks += 1;
						note = "director unreachable";
					}
					directedClips.push(...chunkClips);
				}
				if (fallbackChunks > 0) {
					note = `${fallbackChunks}/${chunks.length} windows heuristic (${note ?? "director failed"})`;
				}
			} else {
				note = "no Gemini key (Final Pass settings) — heuristic framing";
				directedClips.push(...chunks.flatMap((c) => heuristicFor(c).clips));
			}

			// 5. Idempotent insert: delete existing Magic clips inside the
			// scope and insert the new shot list, all in one undo batch.
			// Merging identical adjacent reframes erases chunk seams and turns
			// repeated framings into one calm hold.
			setStage("Laying out clips…");
			const fullShotList = mergeAdjacentReframes(
				clampBrowserChrome(
					sanitizeShotList({
						clips: directedClips,
						scopeStart: 0,
						scopeEnd,
					}),
				),
			);
			const clips = punchesOnly
				? fullShotList.filter((clip) => clip.kind !== "reframe")
				: fullShotList;
			if (clips.length === 0) {
				toast.error(
					punchesOnly
						? "No zoom/highlight beats in this scope — nothing inserted."
						: "Director emptied the shot list — nothing inserted.",
				);
				return;
			}
			const scene = editor.scenes.getActiveScene();
			const staleMagic = scene.tracks.overlay
				.filter((track) => track.type === "effect")
				.flatMap((track) =>
					track.elements
						.filter(
							(el) =>
								el.name.startsWith("Magic: ") &&
								el.startTime < scopeEnd * TICKS_PER_SECOND,
						)
						.map((el) => ({ trackId: track.id, elementId: el.id })),
				);
			const commands: Command[] = [];
			if (staleMagic.length > 0) {
				commands.push(new DeleteElementsCommand({ elements: staleMagic }));
			}
			for (const clip of clips) {
				const spec = planClipToElementSpec({
					clip,
					ticksPerSecond: TICKS_PER_SECOND,
				});
				const element = buildEffectElement({
					effectType: spec.effectType,
					startTime: spec.startTime,
					duration: spec.duration,
				});
				commands.push(
					new InsertElementCommand({
						element: {
							...element,
							name: spec.name,
							params: { ...element.params, ...spec.params },
						},
						placement: { mode: "auto", trackType: "effect" },
					}),
				);
			}
			editor.command.execute({ command: new BatchCommand(commands) });

			const counts = { reframe: 0, zoom: 0, highlight: 0 };
			let coveredSec = 0;
			for (const clip of clips) {
				counts[clip.kind] += 1;
				coveredSec += clip.end - clip.start;
			}
			const coverage = Math.round((coveredSec / (scopeEnd - 0)) * 100);
			toast.success(
				`Auto Magic: ${clips.length} clips over ${Math.round(scopeEnd)}s ` +
					`(${counts.reframe} reframe, ${counts.zoom} zoom, ${counts.highlight} highlight, ${coverage}% covered)` +
					(refined ? " — AI-directed" : "") +
					(cursorCands.length > 0
						? ` · ${cursorCands.length} cursor beats`
						: "") +
					(staleMagic.length > 0
						? ` · replaced ${staleMagic.length} old`
						: "") +
					(note ? ` · ${note}` : "") +
					" · Cmd+Z undoes all",
				{ duration: 9000 },
			);
		} catch (err) {
			console.error("[magic-pass] failed:", err);
			toast.error(
				`Auto Magic failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		} finally {
			setStage(null);
		}
	}, [editor, stage, scope, punchesOnly]);

	// "Attach cursor log…" — parse the sidecar NDJSON client-side and cache
	// the samples in OPFS keyed by this clip's media hash. The next Auto Magic
	// run picks them up; without one the run is exactly v3.
	const attachCursorLog = useCallback(
		async (file: File) => {
			try {
				const found = findRawCutMedia(editor);
				if ("error" in found) {
					toast.error(found.error);
					return;
				}
				const samples = parseCursorLog(await file.text());
				if (samples.length < 2) {
					toast.error(
						"No cursor samples in that file — expected a cursor-sidecar .ndjson log.",
					);
					return;
				}
				const contentHash = await computeFileHash(found.asset.file);
				await writeCursorLog({ contentHash, samples });
				const spanSec =
					(samples[samples.length - 1].timeMs - samples[0].timeMs) / 1000;
				// Pairing sanity: an OBS-script log spans ~the recording. A big
				// mismatch usually means the wrong take's log — warn, still attach.
				const mediaSec = found.asset.duration ?? null;
				const mismatch =
					mediaSec !== null &&
					mediaSec > 30 &&
					Math.abs(spanSec - mediaSec) / mediaSec > 0.25;
				toast.success(
					`Cursor log attached: ${samples.length} samples over ${Math.round(spanSec)}s — the next Auto Magic run uses it.`,
				);
				if (mismatch) {
					toast.warning(
						`Heads up: the log spans ${Math.round(spanSec)}s but this clip's media is ${Math.round(mediaSec)}s — is it the right take's cursor file?`,
						{ duration: 9000 },
					);
				}
			} catch (err) {
				console.error("[magic-pass] cursor log attach failed:", err);
				toast.error(
					`Couldn't attach cursor log: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		},
		[editor],
	);

	// Drop-anywhere pairing: the OBS sidecar script drops `<take>.cursor.ndjson`
	// next to the recording — dragging it anywhere in the editor attaches it,
	// no menu hunting. Capture phase so the assets/timeline drop zones never
	// see ndjson payloads; any other payload passes through untouched.
	useEffect(() => {
		const isNdjsonDrop = (dt: DataTransfer | null): File[] | null => {
			if (!dt) return null;
			const files = [...dt.files];
			if (files.length === 0) return null;
			return files.every((f) => /\.ndjson$/i.test(f.name)) ? files : null;
		};
		const onDragOver = (e: DragEvent) => {
			// Mark file drags as droppable app-wide; without this a stray drop
			// navigates the browser away from the editor.
			if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
		};
		const onDrop = (e: DragEvent) => {
			const files = isNdjsonDrop(e.dataTransfer);
			if (!files) return;
			e.preventDefault();
			e.stopPropagation();
			void attachCursorLog(files[0]);
		};
		window.addEventListener("dragover", onDragOver, true);
		window.addEventListener("drop", onDrop, true);
		return () => {
			window.removeEventListener("dragover", onDragOver, true);
			window.removeEventListener("drop", onDrop, true);
		};
	}, [attachCursorLog]);

	return (
		<div className="flex items-center">
			<Button
				variant="outline"
				size="sm"
				onClick={run}
				disabled={stage !== null}
				className="gap-1.5 rounded-r-none border-r-0"
			>
				<Wand2 className="size-3.5" />
				{stage ?? `Auto Magic · ${scope === "2min" ? "2 min" : "full"}`}
			</Button>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						disabled={stage !== null}
						className="rounded-l-none px-1.5"
						aria-label="Auto Magic scope"
					>
						<ChevronDown className="size-3.5" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuRadioGroup
						value={scope}
						onValueChange={(v) => setScope(v as MagicScope)}
					>
						<DropdownMenuRadioItem value="2min">
							First 2 minutes
						</DropdownMenuRadioItem>
						<DropdownMenuRadioItem value="full">
							Full video
						</DropdownMenuRadioItem>
					</DropdownMenuRadioGroup>
					<DropdownMenuSeparator />
					<DropdownMenuCheckboxItem
						checked={punchesOnly}
						onCheckedChange={(v) => setPunchesOnly(v === true)}
					>
						Zoom + highlight only (no reframes)
					</DropdownMenuCheckboxItem>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onSelect={() => cursorFileRef.current?.click()}
					>
						<MousePointerClick className="size-3.5" />
						Attach cursor log…
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<input
				ref={cursorFileRef}
				type="file"
				accept=".ndjson,.jsonl,.txt,.log,application/x-ndjson"
				className="hidden"
				onChange={(e) => {
					const file = e.target.files?.[0];
					e.target.value = "";
					if (file) void attachCursorLog(file);
				}}
			/>
		</div>
	);
}
