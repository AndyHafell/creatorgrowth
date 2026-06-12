"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/hooks/use-editor";
import { sendRawCutToTimeline } from "@/lib/raw-cut/export-to-timeline";
import type { SilenceRange } from "@/lib/media/audio";
import type { MediaAsset } from "@/lib/media/types";
import {
	getMemoryBuffer,
	loadCachedAnalysisBuffer,
	storeCachedAnalysisBuffer,
} from "@/lib/raw-cut/decode-cache";
import { cutRunEndMediaSec } from "@/lib/raw-cut/segments";
import {
	computeFileHash,
	readCachedTranscription,
	writeCachedTranscription,
} from "@/lib/raw-cut/transcription-cache";
import { RawCutWaveform } from "../raw-cut/raw-cut-waveform";
import { useRawCutSegments } from "../raw-cut/use-raw-cut-segments";
import {
	buildRmsEnvelope,
	decodeFinalPassAudio,
	encodeWav,
	resampleMono,
	snapToQuietest,
} from "./final-pass-audio";
import { FinalPassChat, type FinalPassChatMessage } from "./final-pass-chat";
import { FinalPassKeys } from "./final-pass-keys";
import {
	elevenHeaders,
	geminiHeaders,
	getStoredKey,
} from "@/lib/final-pass/api-keys";
import {
	type Analysis,
	type Chapter,
	type Cut,
	type FeedbackMarker,
	hashTranscript,
	readAnalysisCache,
	readChaptersCache,
	readFeedbackCache,
	readRulebook,
	readSegmentsCache,
	recallContentHash,
	rememberContentHash,
	writeAnalysisCache,
	writeChaptersCache,
	writeFeedbackCache,
	writeSegmentsCache,
} from "./final-pass-cache";
import { mergeShortKeepIslands } from "./final-pass-denoise";
import { computeCutDiff, type CutDiff } from "./final-pass-diff";
import { FinalPassRulebook } from "./final-pass-rulebook";
import { FinalPassTeach } from "./final-pass-teach";
import { useFinalPassKeybindings } from "./use-final-pass-keybindings";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/lib/transcription/audio";
import {
	DEFAULT_TRANSCRIPTION_MODEL,
	TRANSCRIPTION_MODELS,
} from "@/lib/transcription/models";
import type { TranscriptionSegment } from "@/lib/transcription/types";
import { transcriptionService } from "@/services/transcription/service";
import { useEditorModeStore } from "@/stores/editor-mode-store";
import { cn } from "@/utils/ui";

// Waveform zoom bounds + max shuttle speed — matched to Raw Cut so the timeline
// "feels" identical (Z/X step, 1/2/3/L speed).
const ZOOM_STEP = 1.7;
const ZOOM_MAX = 500;
const MAX_SPEED = 4;
// Predictive skip-cuts lead (wall-time seconds): issue the cut-skip seek this far
// BEFORE the playhead reaches a keep→cut boundary so no red is ever queued to the
// audio output (the residual-leak fix). Scaled by playbackRate at the call site.
// Must exceed the media pipeline depth (decode-ahead + OS output buffer, ~0.15-0.2s
// wall) or a sliver of red leaks past pause()+mute; 0.12 still leaked, so 0.22.
// Boundaries are snapped to silence, so the clipped green tail stays inaudible. Tunable.
const SKIP_LEAD_SEC = 0.22;
// Score at/above which the video is "greenlit" — kept in sync with the routes.
const GREENLIT_CUTOFF = 7.0;

// Cache id for cloud (ElevenLabs Scribe) transcripts — distinct from the
// in-browser Whisper model id so the two don't collide; restore tries this first.
const CLOUD_MODEL_ID = "elevenlabs-scribe_v1";

// Monotonic id for chat messages (stable React keys; no array-index keys).
let chatMsgSeq = 0;
const nextChatMsgId = () => `m${++chatMsgSeq}`;

// Stable React keys for chapter rows (survive title edits + reorder on retime).
let chapterSeq = 0;
const nextChapterId = () => `ch${++chapterSeq}`;

// Stable React keys for feedback-marker rows (same reasoning as chapters).
let feedbackSeq = 0;
const nextFeedbackId = () => `fb${++feedbackSeq}`;

// Counts seconds up while `key` is a non-null phase, resetting to 0 whenever the
// phase string changes (or clears to null). Keyed on the PHASE — not the whole
// status object — so progress ticks within a phase (which recreate the status
// object every frame) don't restart the count. This is the fix for the stuck
// "Preparing audio… 42% · 0s" timer, and it also makes the transcribing and
// analyze lines count up.
function useElapsedSeconds(key: string | null): number {
	const [sec, setSec] = useState(0);
	useEffect(() => {
		if (!key) {
			setSec(0);
			return;
		}
		const start = performance.now();
		setSec(0);
		const id = window.setInterval(() => {
			setSec((performance.now() - start) / 1000);
		}, 500);
		return () => window.clearInterval(id);
	}, [key]);
	return sec;
}

// Final Pass — the AI advisor page (Edit · Raw Cut · Final Pass). Sibling to
// Raw Cut: pick a clip → load the video → read-along transcript (Whisper) →
// AI red-cuts the fluff (Step 3). The 1–10 score readout is Step 4.
export function FinalPassSurface() {
	const mediaFiles = useEditor((e) => e.media.getAssets());
	const finalPassMediaId = useEditorModeStore((s) => s.finalPassMediaId);
	const openInFinalPass = useEditorModeStore((s) => s.openInFinalPass);
	const clearFinalPassMedia = useEditorModeStore((s) => s.clearFinalPassMedia);

	const gradeable = useMemo(
		() =>
			mediaFiles.filter(
				(m) => !m.ephemeral && (m.type === "video" || m.type === "audio"),
			),
		[mediaFiles],
	);

	const selected = useMemo(
		() => gradeable.find((m) => m.id === finalPassMediaId) ?? null,
		[gradeable, finalPassMediaId],
	);

	return (
		<div className="bg-background flex h-full w-full flex-col overflow-hidden">
			{selected ? (
				// Keyed by id so picking a different clip mounts a fresh component.
				<LoadedClip
					key={selected.id}
					asset={selected}
					onChange={clearFinalPassMedia}
				/>
			) : (
				<ClipPicker clips={gradeable} onPick={openInFinalPass} />
			)}
		</div>
	);
}

function ClipPicker({
	clips,
	onPick,
}: {
	clips: MediaAsset[];
	onPick: (id: string) => void;
}) {
	if (clips.length === 0) {
		return (
			<div className="flex flex-1 items-center justify-center">
				<div className="text-muted-foreground max-w-md text-center text-sm">
					Import or edit a video in Edit mode, then come back here to give it a
					final pass.
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col items-center overflow-y-auto px-6 py-10">
			<div className="w-full max-w-2xl">
				<h2 className="text-foreground text-lg font-semibold">
					Pick a video to grade
				</h2>
				<p className="text-muted-foreground mt-1 text-sm">
					Final Pass scores it 1–10 and red-cuts the fluff before you publish.
				</p>
				<div className="mt-6 flex flex-col gap-2">
					{clips.map((clip) => (
						<button
							key={clip.id}
							type="button"
							onClick={() => onPick(clip.id)}
							className="hover:bg-accent flex items-center gap-3 rounded-md border px-3 py-2 text-left text-sm"
						>
							<Thumb asset={clip} />
							<div className="min-w-0 flex-1">
								<div className="truncate">{clip.name}</div>
								<div className="text-muted-foreground text-xs">
									{clip.type} · {formatDuration(clip.duration)}
								</div>
							</div>
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

// Transcription lifecycle for the read-along panel. Progress reality (from the
// worker): model download reports 0–100; audio decode reports a 0–1 fraction;
// transcription itself reports NO progress (only streamed chunk text), so that
// phase is driven off the live line count + an elapsed timer instead of a %.
type TranscribeStatus =
	| { kind: "idle" }
	| { kind: "preloading"; progress: number }
	| { kind: "decoding"; progress: number }
	| { kind: "loading-model"; progress: number }
	| { kind: "transcribing"; lines: number }
	| { kind: "cloud" }
	| { kind: "done"; cached: boolean; durationMs: number }
	| { kind: "error"; message: string };

function isBusy(status: TranscribeStatus): boolean {
	return (
		status.kind === "decoding" ||
		status.kind === "loading-model" ||
		status.kind === "transcribing" ||
		status.kind === "cloud"
	);
}

// Output contract from /api/final-pass — `Cut` / `Analysis` are defined in
// ./final-pass-cache (shared with the cache + chat layers) and imported above.

function LoadedClip({
	asset,
	onChange,
}: {
	asset: MediaAsset;
	onChange: () => void;
}) {
	const editor = useEditor();
	const setMode = useEditorModeStore((s) => s.setMode);
	const mediaRef = useRef<HTMLVideoElement | HTMLAudioElement | null>(null);
	const [currentTime, setCurrentTime] = useState(0);
	const [segments, setSegments] = useState<TranscriptionSegment[]>([]);
	const [status, setStatus] = useState<TranscribeStatus>({ kind: "idle" });
	const [device, setDevice] = useState<"webgpu" | "wasm" | null>(null);

	// Step 3 — AI red-cuts.
	const [analysis, setAnalysis] = useState<Analysis | null>(null);
	const [analyzing, setAnalyzing] = useState(false);
	const [analyzeError, setAnalyzeError] = useState<string | null>(null);

	// Content hash of the clip's file — the STABLE key for the per-clip caches
	// (analysis + chapters), so they survive a re-import (which mints a new asset
	// id), not just a reload. Seeded synchronously from the localStorage pointer;
	// the transcription effects refine it with the real file hash.
	const [contentHash, setContentHash] = useState<string | null>(() =>
		recallContentHash(asset.id),
	);

	// Resizable preview height (px) — drag the handle under the player. Persisted
	// per browser so the size sticks across clips/reloads.
	const [playerH, setPlayerH] = useState(360);
	const playerDragRef = useRef<{ y: number; h: number } | null>(null);
	useEffect(() => {
		try {
			const s = localStorage.getItem("finalpass:playerH");
			if (s) setPlayerH(Math.max(160, Math.min(900, Number(s))));
		} catch {
			/* ignore */
		}
	}, []);
	const onPlayerResizeDown = useCallback(
		(e: React.PointerEvent) => {
			playerDragRef.current = { y: e.clientY, h: playerH };
			(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		},
		[playerH],
	);
	const onPlayerResizeMove = useCallback((e: React.PointerEvent) => {
		const d = playerDragRef.current;
		if (!d) return;
		setPlayerH(Math.max(160, Math.min(900, d.h + (e.clientY - d.y))));
	}, []);
	const onPlayerResizeUp = useCallback(() => {
		if (!playerDragRef.current) return;
		playerDragRef.current = null;
		try {
			localStorage.setItem("finalpass:playerH", String(playerH));
		} catch {
			/* ignore */
		}
	}, [playerH]);

	// Bumped on each run so a stale async pass can't write over a newer one.
	const runIdRef = useRef(0);

	// --- Raw Cut timeline machinery (waveform + playback shuttle + zoom). ---
	// Analysis AudioBuffer for the waveform. Pulled synchronously from the shared
	// decode cache (Raw Cut may have already decoded this clip); a cold clip
	// decodes in the effect below.
	const [buffer, setBuffer] = useState<AudioBuffer | null>(
		() => getMemoryBuffer(asset.id) ?? null,
	);
	const [decoding, setDecoding] = useState(false);
	const [decodeProgress, setDecodeProgress] = useState(0);
	const [decodeErr, setDecodeErr] = useState<string | null>(null);
	// Real playable duration from the media element — the authoritative timebase
	// for the playhead/seek (the 8kHz analysis buffer drifts shorter).
	const [mediaDuration, setMediaDuration] = useState<number | null>(null);
	const [isPlaying, setIsPlaying] = useState(false);
	const [speedState, setSpeedState] = useState(1);
	// Preview mode: when on, playback skips the red (cut) regions so Andy hears
	// the final edit. Off lets him play the whole clip straight through (needed
	// when auditing cut content by hand). Read from the rAF loop via a ref.
	const [skipCuts, setSkipCuts] = useState(true);
	const skipCutsRef = useRef(true);
	skipCutsRef.current = skipCuts;
	// The cut-skip tick fn from the segment model (defined later); the playback
	// loop calls it through this ref so the effect doesn't depend on cutModel.
	const onPlaybackTickRef = useRef<
		| ((
				mediaSec: number,
				opts?: { leadSec?: number; playThroughUntilSec?: number },
		  ) => "continue" | "stop")
		| null
	>(null);
	// When playback STARTS inside a cut Andy clicked into, this holds the media-sec
	// end of that cut run so the rAF loop plays THROUGH the red instead of skipping
	// it (only green→red crossings skip). Captured at play-start, cleared once the
	// playhead passes it.
	const playThroughUntilRef = useRef<number | null>(null);
	// Latest speed, readable from event handlers without a stale closure. The
	// media element silently resets playbackRate on some transitions, so we set
	// BOTH playbackRate + defaultPlaybackRate and reassert on every play/tick.
	const speedRef = useRef(1);
	// Waveform zoom: 1 = fit entire clip; Z/X step it (centered on playhead).
	const [zoom, setZoom] = useState(1);

	// Step 4 — the AI chatbot. It owns the score conversationally and mutates the
	// same `analysis.cuts` the transcript + timeline render from.
	const [chatOpen, setChatOpen] = useState(false);
	const [chatMessages, setChatMessages] = useState<FinalPassChatMessage[]>([]);
	const [chatLoading, setChatLoading] = useState(false);
	const [chatError, setChatError] = useState<string | null>(null);
	// Score the bot projects we'd reach if the current cuts are applied.
	const [projectedScore, setProjectedScore] = useState<number | null>(null);

	// Chapters — AI-detected step/section markers Andy verifies + exports to the
	// YouTube description. Persisted per asset (incl. his manual title/time edits).
	const [chapters, setChapters] = useState<Chapter[]>([]);
	const [chaptersDetecting, setChaptersDetecting] = useState(false);
	const [chaptersError, setChaptersError] = useState<string | null>(null);
	const [copiedChapters, setCopiedChapters] = useState(false);

	// Feedback markers — purple pins Andy drops (N) with a note auto-prefixed with
	// the MM:SS timestamp, so the learning loop (Part B) knows where each applies.
	// Restored synchronously at mount (asset-id keyed, like the segment cache) so a
	// reload keeps them. They live ONLY on the timeline (no side panel): double-
	// click a pin — or press N to add one — to edit its note inline at the pin.
	// `editingFeedbackId` = the pin whose inline note editor is open.
	const [feedback, setFeedback] = useState<FeedbackMarker[]>(
		() => readFeedbackCache(asset.id) ?? [],
	);
	const [editingFeedbackId, setEditingFeedbackId] = useState<string | null>(
		null,
	);
	// Same inline-on-the-timeline editing for blue CHAPTER pins (double-click or M).
	const [editingChapterId, setEditingChapterId] = useState<string | null>(null);

	const handleSeek = useCallback((sec: number) => {
		const el = mediaRef.current;
		if (!el) return;
		el.currentTime = sec;
		setCurrentTime(sec);
	}, []);

	// Cancels a pending "resume after seek" from an in-flight skip (below).
	const skipResumeRef = useRef<(() => void) | null>(null);

	// Skip-cuts jump (auto-skip over red regions during playback). Layered leak fix:
	//  1) the predictive lead (skipDecision) seeks BEFORE the cut boundary, so red
	//     is never the playback position;
	//  2) we MUTE through the whole pause→seek→resume transition — `pause()` lets
	//     the already-queued audio buffer (~0.1s, which reaches just past the
	//     boundary into the red) drain audibly, so muting silences that tail. We
	//     unmute exactly when we resume at the post-cut green;
	//  3) resume play ONLY after the 'seeked' event (a 600ms timeout fallback), so
	//     the audio decoded ahead of the OLD position isn't replayed on resume.
	const skipSeek = useCallback((sec: number) => {
		const el = mediaRef.current;
		if (!el) return;
		// A new skip supersedes any still-pending resume.
		skipResumeRef.current?.();
		const wasPlaying = !el.paused;
		// Silence the buffered tail through the transition (see #2 above).
		el.muted = true;
		el.pause();
		el.currentTime = sec;
		setCurrentTime(sec);
		if (!wasPlaying) {
			el.muted = false;
			return;
		}
		let done = false;
		const resume = () => {
			if (done) return;
			done = true;
			el.removeEventListener("seeked", resume);
			window.clearTimeout(timer);
			skipResumeRef.current = null;
			el.playbackRate = speedRef.current;
			el.muted = false; // unmute exactly at the post-cut green
			void el.play().catch(() => {});
		};
		const timer = window.setTimeout(resume, 600);
		el.addEventListener("seeked", resume);
		skipResumeRef.current = () => {
			done = true;
			el.removeEventListener("seeked", resume);
			window.clearTimeout(timer);
			skipResumeRef.current = null;
			// leave muted — the superseding skip's resume unmutes at its green.
		};
	}, []);

	// Decode the analysis buffer once on mount for the waveform. Order: in-memory
	// (already seeded) → OPFS decode cache → full decode. Mirrors Raw Cut so the
	// two share the cache (open a clip in Raw Cut, then here = instant restore).
	// `asset` (beyond .id) intentionally excluded — runs once per asset.
	// biome-ignore lint/correctness/useExhaustiveDependencies: per-asset, see note
	useEffect(() => {
		if (getMemoryBuffer(asset.id)) {
			setDecoding(false);
			return;
		}
		let cancelled = false;
		setDecoding(true);
		setDecodeErr(null);
		(async () => {
			try {
				const cached = await loadCachedAnalysisBuffer(asset.id);
				if (cancelled) return;
				if (cached) {
					setBuffer(cached);
					return;
				}
				const buf = await decodeFinalPassAudio({
					asset,
					onProgress: (pct) => {
						if (!cancelled) setDecodeProgress(pct);
					},
				});
				if (cancelled) return;
				if (buf) {
					setBuffer(buf);
					void storeCachedAnalysisBuffer(asset.id, buf);
				} else {
					setDecodeErr("Couldn't read this clip's audio for the waveform.");
				}
			} catch (err) {
				if (!cancelled) setDecodeErr((err as Error).message);
				console.warn("[final-pass] waveform decode failed", err);
			} finally {
				if (!cancelled) setDecoding(false);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [asset.id]);

	const togglePlay = useCallback(() => {
		const el = mediaRef.current;
		if (!el) return;
		if (el.paused) void el.play();
		else el.pause();
	}, []);

	const zoomIn = useCallback(
		() => setZoom((z) => Math.min(ZOOM_MAX, z * ZOOM_STEP)),
		[],
	);
	const zoomOut = useCallback(
		() => setZoom((z) => Math.max(1, z / ZOOM_STEP)),
		[],
	);
	// Proportional wheel zoom (vertical scroll over the waveform).
	const zoomBy = useCallback(
		(factor: number) =>
			setZoom((z) => Math.max(1, Math.min(ZOOM_MAX, z * factor))),
		[],
	);

	// Playback rate (2x/3x review) — applied to the media element directly.
	const applySpeed = useCallback((rate: number) => {
		speedRef.current = rate;
		setSpeedState(rate);
		const el = mediaRef.current;
		if (el) {
			el.playbackRate = rate;
			el.defaultPlaybackRate = rate;
		}
	}, []);
	const setSpeed = useCallback(
		(rate: number) => {
			applySpeed(rate);
			const el = mediaRef.current;
			if (el?.paused) void el.play();
		},
		[applySpeed],
	);
	const speedUp = useCallback(() => {
		const next = Math.min(MAX_SPEED, Math.round(speedRef.current) + 1);
		applySpeed(next);
		const el = mediaRef.current;
		if (el?.paused) void el.play();
	}, [applySpeed]);
	const pausePlayback = useCallback(() => {
		mediaRef.current?.pause();
	}, []);

	// Frame seconds from the project fps (fallback 30fps for raw assets).
	const fps = editor.project.getActive()?.settings?.fps;
	const frameSec =
		fps && fps.numerator > 0 ? fps.denominator / fps.numerator : 1 / 30;
	const stepFrames = useCallback(
		(frames: number) => {
			const el = mediaRef.current;
			if (!el) return;
			const max = mediaDuration ?? el.duration ?? asset.duration ?? Infinity;
			const next = Math.max(
				0,
				Math.min(max, el.currentTime + frames * frameSec),
			);
			el.currentTime = next;
			setCurrentTime(next);
		},
		[frameSec, mediaDuration, asset.duration],
	);
	const jumpSeconds = useCallback(
		(delta: number) => {
			const el = mediaRef.current;
			if (!el) return;
			const max = mediaDuration ?? el.duration ?? asset.duration ?? Infinity;
			const next = Math.max(0, Math.min(max, el.currentTime + delta));
			el.currentTime = next;
			setCurrentTime(next);
		},
		[mediaDuration, asset.duration],
	);

	// Playback loop (rAF): glide the playhead and keep the rate pinned (the media
	// element silently drops playbackRate otherwise — the 2x/3x persistence bug).
	// When "Skip cuts" is on we jump over red regions (via the segment model's
	// onPlaybackTick) so Andy previews the final edit; when off it plays straight
	// through so he can audit the cut content by hand.
	useEffect(() => {
		if (!isPlaying) return;
		let raf = 0;
		const tick = () => {
			const el = mediaRef.current;
			if (el) {
				if (el.playbackRate !== speedRef.current) {
					el.playbackRate = speedRef.current;
				}
				if (skipCutsRef.current && onPlaybackTickRef.current) {
					// Predictive lead scales with playback rate: at 3× the element
					// burns through 3× the content per wall-second, so we need 3× the
					// content lead to seek the same wall-time before the boundary.
					const leadSec = SKIP_LEAD_SEC * speedRef.current;
					// Drop the play-through guard once we've played past the cut we
					// started inside, so later green→red crossings skip normally.
					const pt = playThroughUntilRef.current;
					if (pt != null && el.currentTime >= pt) {
						playThroughUntilRef.current = null;
					}
					if (
						onPlaybackTickRef.current(el.currentTime, {
							leadSec,
							playThroughUntilSec: playThroughUntilRef.current ?? undefined,
						}) === "stop"
					) {
						el.pause();
						return;
					}
				}
				setCurrentTime(el.currentTime);
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [isPlaying]);

	// Ask the browser to keep our caches (OPFS transcripts + localStorage
	// analysis/chapters) from being evicted. Without this a long-idle tab or a
	// storage-pressure sweep can drop them and force a full re-transcribe — the
	// "start from scratch every time" symptom.
	useEffect(() => {
		void navigator.storage?.persist?.().catch(() => {});
	}, []);

	// Warm the model in the background as soon as a clip mounts, so clicking
	// Transcribe is instant instead of sitting on "loading model 0%". No-op (and
	// returns instantly) if Raw Cut already loaded it this session.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			try {
				await transcriptionService.preload({
					modelId: DEFAULT_TRANSCRIPTION_MODEL,
					onProgress: (p) => {
						if (cancelled || p.status !== "loading-model") return;
						setStatus((cur) =>
							cur.kind === "idle" || cur.kind === "preloading"
								? { kind: "preloading", progress: p.progress }
								: cur,
						);
					},
				});
				if (cancelled) return;
				setDevice(transcriptionService.getActiveDevice());
			} catch (err) {
				console.warn("[final-pass] model preload failed", err);
			} finally {
				if (!cancelled) {
					setStatus((cur) =>
						cur.kind === "preloading" ? { kind: "idle" } : cur,
					);
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// Run the full read-along transcription: cache hit (instant if Raw Cut
	// already transcribed this exact file) → else decode 16k mono → stream
	// Whisper segments in → cache the result.
	const transcribe = useCallback(async () => {
		const runId = ++runIdRef.current;
		setSegments([]);
		setAnalysis(null);
		setAnalyzeError(null);
		const t0 = performance.now();
		const modelHfId =
			TRANSCRIPTION_MODELS.find((m) => m.id === DEFAULT_TRANSCRIPTION_MODEL)
				?.huggingFaceId ?? DEFAULT_TRANSCRIPTION_MODEL;

		try {
			// 1) Cache lookup by content hash. A stale File handle (post-reload)
			// throws when hashing — so we remember the hash on every success and
			// recover it here, instead of skipping the cache and forcing a full
			// re-transcribe (the "had to re-transcribe the whole thing" annoyance).
			let contentHash: string | null = null;
			try {
				contentHash = await computeFileHash(asset.file);
				rememberContentHash(asset.id, contentHash);
			} catch (err) {
				contentHash = recallContentHash(asset.id);
				if (!contentHash) {
					console.warn("[final-pass] could not hash file for cache:", err);
				}
			}
			if (contentHash) setContentHash(contentHash);
			if (runId !== runIdRef.current) return;
			const cached = contentHash
				? ((await readCachedTranscription({
						contentHash,
						modelId: CLOUD_MODEL_ID,
					})) ??
					(await readCachedTranscription({ contentHash, modelId: modelHfId })))
				: null;
			if (runId !== runIdRef.current) return;
			if (cached) {
				setSegments(cached.segments);
				setStatus({
					kind: "done",
					cached: true,
					durationMs: performance.now() - t0,
				});
				return;
			}

			// Transcription REQUIRES the member's ElevenLabs key. The free
			// in-browser Whisper fallback is intentionally disabled — its loose
			// timestamps make the red/green cuts + chapters noticeably worse, so we
			// warn instead of silently shipping an inferior result.
			if (getStoredKey("eleven").length === 0) {
				setStatus({
					kind: "error",
					message:
						'Add your ElevenLabs API key in "API keys" to transcribe. The free in-browser model is disabled because its timing is too loose for accurate cuts.',
				});
				return;
			}

			// 2) Get 16k mono samples for Whisper. PREFER a dedicated TRUE-16k
			// streaming decode (mediabunny: chunked + yields, so memory-safe even on
			// a 30-min clip — this is NOT the decodeAudioData path that OOM'd). The
			// waveform buffer is 8 kHz (4 kHz Nyquist — phone-quality), and
			// upsampling it to 16k can't recover the high-frequency detail Whisper
			// needs, which hurt word + timestamp accuracy. Fall back to upsampling
			// the already-decoded 8k buffer only if the 16k decode returns null.
			setStatus({ kind: "decoding", progress: 0 });
			let samples: Float32Array | null = null;
			const decoded16k = await decodeFinalPassAudio({
				asset,
				targetSampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
				onProgress: (frac) => {
					if (runId !== runIdRef.current) return;
					setStatus({ kind: "decoding", progress: frac });
				},
			});
			if (runId !== runIdRef.current) return;
			if (decoded16k) {
				samples = decoded16k.getChannelData(0);
			} else if (buffer) {
				samples = resampleMono(
					buffer.getChannelData(0),
					buffer.sampleRate,
					DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
				);
			}
			if (!samples || samples.length === 0) {
				setStatus({
					kind: "error",
					message:
						"Couldn't read this clip's audio (no decodable track). Try re-importing the file in Edit.",
				});
				return;
			}

			// 3) Cloud transcription (ElevenLabs Scribe) when a key is configured —
			// word-level timestamps, returns in seconds, no multi-minute local wait.
			// Falls through to in-browser Whisper when no key / it errors.
			const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
			// Cloud transcription (ElevenLabs Scribe) runs on the member's OWN key,
			// pasted in "API keys". No key → fall through to the free in-browser
			// Whisper below, so transcription still works for everyone.
			const cloudEnabled = getStoredKey("eleven").length > 0;
			if (runId !== runIdRef.current) return;

			if (cloudEnabled) {
				setStatus({ kind: "cloud" });
				const wav = encodeWav(samples, DEFAULT_TRANSCRIPTION_SAMPLE_RATE);
				const fd = new FormData();
				fd.set("file", wav, "audio.wav");
				const res = await fetch(`${base}/api/final-pass/transcribe-cloud`, {
					method: "POST",
					headers: elevenHeaders(),
					body: fd,
				});
				if (!res.ok) {
					const d = (await res.json().catch(() => null)) as {
						error?: string;
					} | null;
					throw new Error(
						d?.error ?? `Cloud transcription failed (${res.status})`,
					);
				}
				const data = (await res.json()) as {
					segments: TranscriptionSegment[];
					text?: string;
				};
				if (runId !== runIdRef.current) return;
				setSegments(data.segments);
				if (contentHash) {
					void writeCachedTranscription({
						cache: {
							version: 1,
							contentHash,
							modelId: CLOUD_MODEL_ID,
							segments: data.segments,
							text: data.text ?? "",
							createdAt: Date.now(),
						},
					});
				}
				setStatus({
					kind: "done",
					cached: false,
					durationMs: performance.now() - t0,
				});
				return;
			}

			// 4) In-browser Whisper fallback. The worker emits no transcription
			// %, and streamed chunk timestamps are CHUNK-LOCAL (each ~30s window
			// restarts at 0) — only the final result has absolute times. So we drive
			// live feedback off the line count and trust only result.segments for the
			// real timeline (see the `ready` gate on the timestamps).
			const live: TranscriptionSegment[] = [];
			const result = await transcriptionService.transcribe({
				audioData: samples,
				modelId: DEFAULT_TRANSCRIPTION_MODEL,
				onProgress: (p) => {
					if (runId !== runIdRef.current) return;
					if (p.status === "loading-model") {
						setStatus({ kind: "loading-model", progress: p.progress });
					} else if (p.status === "transcribing") {
						setStatus({ kind: "transcribing", lines: live.length });
					}
				},
				onSegment: (seg) => {
					if (runId !== runIdRef.current) return;
					live.push(seg);
					setSegments([...live]);
					setStatus({ kind: "transcribing", lines: live.length });
				},
			});
			if (runId !== runIdRef.current) return;

			// Swap the chunk-local streamed segments for the final absolute-timed
			// ones — this is what makes click-to-seek and the timestamps correct.
			setSegments(result.segments);
			setDevice(transcriptionService.getActiveDevice());
			if (contentHash) {
				void writeCachedTranscription({
					cache: {
						version: 1,
						contentHash,
						modelId: modelHfId,
						segments: result.segments,
						text: result.text,
						createdAt: Date.now(),
					},
				});
			}
			setStatus({
				kind: "done",
				cached: false,
				durationMs: performance.now() - t0,
			});
		} catch (err) {
			if (runId !== runIdRef.current) return;
			setStatus({ kind: "error", message: (err as Error).message });
		}
	}, [asset, buffer]);

	// Auto-restore a cached transcript on mount, so a reload (or re-opening the
	// clip) shows the read-along instantly with no re-transcribe. Recovers the
	// content hash from the file, or from the remembered pointer when the File
	// handle went stale. No-op on a miss — the Transcribe button still works.
	useEffect(() => {
		let cancelled = false;
		(async () => {
			const modelHfId =
				TRANSCRIPTION_MODELS.find((m) => m.id === DEFAULT_TRANSCRIPTION_MODEL)
					?.huggingFaceId ?? DEFAULT_TRANSCRIPTION_MODEL;
			let contentHash: string | null = null;
			try {
				contentHash = await computeFileHash(asset.file);
				rememberContentHash(asset.id, contentHash);
			} catch {
				contentHash = recallContentHash(asset.id);
			}
			if (cancelled || !contentHash) return;
			setContentHash(contentHash);
			// Cloud transcript first (it's the primary engine now), then in-browser.
			const cached =
				(await readCachedTranscription({
					contentHash,
					modelId: CLOUD_MODEL_ID,
				})) ??
				(await readCachedTranscription({ contentHash, modelId: modelHfId }));
			if (cancelled || !cached) return;
			// Don't clobber a run the user already kicked off this mount.
			setStatus((cur) =>
				cur.kind === "idle" || cur.kind === "preloading"
					? { kind: "done", cached: true, durationMs: 0 }
					: cur,
			);
			setSegments((cur) => (cur.length === 0 ? cached.segments : cur));
		})();
		return () => {
			cancelled = true;
		};
	}, [asset.id, asset.file]);

	// Per-phase elapsed timers — give visible motion even when the underlying
	// step reports no %, so it never looks frozen. Keyed on the PHASE string (not
	// the whole status object), so a progress tick within a phase no longer
	// restarts the count at 0.
	const transcribePhase =
		isBusy(status) || status.kind === "preloading" ? status.kind : null;
	const elapsedSec = useElapsedSeconds(transcribePhase);
	// "Analyzing… Ns" for the Gemini read + chat-init wait (the post-transcribe
	// step). Stops once the first chat reply lands; later chat turns have their
	// own indicator in the chat panel.
	const analyzeBusy = analyzing || (chatLoading && chatMessages.length === 0);
	const analyzeElapsedSec = useElapsedSeconds(analyzeBusy ? "analyzing" : null);

	// Timestamps, click-to-seek, and red-cut analysis only make sense once we
	// have the final absolute-timed transcript.
	const ready = status.kind === "done";

	// Send the transcript to Gemini for the editorial read. The result is
	// CACHED per asset (keyed by the transcript signature), so re-opening the
	// clip restores the score + cuts for free — only an explicit Re-analyze
	// (force) re-bills. This is the "save some cash" fix: every prior Re-analyze
	// hit the paid route even when the transcript hadn't changed.
	const analyze = useCallback(
		async (opts?: { force?: boolean }): Promise<Analysis | null> => {
			if (segments.length === 0) return null;
			const transcriptHash = hashTranscript(segments);
			if (!opts?.force && contentHash) {
				const hit = readAnalysisCache({ contentHash, transcriptHash });
				if (hit) {
					setAnalysis(hit);
					return hit;
				}
			}
			setAnalyzing(true);
			setAnalyzeError(null);
			try {
				const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
				const res = await fetch(`${base}/api/final-pass`, {
					method: "POST",
					headers: { "Content-Type": "application/json", ...geminiHeaders() },
					// rulebook (Part B v1): Andy's "cut rules" injected as LEARNED EDITOR
					// PREFERENCES so the first pass cuts to his taste.
					body: JSON.stringify({ segments, rulebook: readRulebook() }),
				});
				if (!res.ok) {
					const data = (await res.json().catch(() => null)) as {
						error?: string;
					} | null;
					throw new Error(data?.error ?? `Request failed (${res.status})`);
				}
				const data = (await res.json()) as Analysis;
				setAnalysis(data);
				if (contentHash) {
					writeAnalysisCache({ contentHash, transcriptHash, analysis: data });
				}
				return data;
			} catch (err) {
				setAnalyzeError((err as Error).message);
				return null;
			} finally {
				setAnalyzing(false);
			}
		},
		[segments, contentHash],
	);

	// Restore a cached analysis once the transcript is ready (and we don't
	// already have one), so re-opening OR re-importing a clip shows the prior
	// score + red cuts instantly without another Gemini call.
	useEffect(() => {
		if (!ready || segments.length === 0 || analysis || !contentHash) return;
		const hit = readAnalysisCache({
			contentHash,
			transcriptHash: hashTranscript(segments),
		});
		if (hit) {
			setAnalysis(hit);
		}
	}, [ready, segments, analysis, contentHash]);

	// --- Editable keep/cut, seeded from the AI cuts (Raw Cut's segment model) ---
	// so Andy can run the whole video toggling keep/cut by hand with the Q/W/E/O/S
	// keymap + clicking. The AI cuts are in media seconds; the segment model works
	// in the 8k buffer timebase, so we scale by bufferDuration/mediaDuration (the
	// two drift slightly apart). Changing the AI cuts (via the chat) reseeds it.
	const bufDur = buffer?.duration ?? 0;
	const medDur = mediaDuration ?? asset.duration ?? bufDur;
	// RMS envelope of the decoded audio, for snapping cut boundaries off peaks
	// and into the quiet gaps between words. Rebuilt only when the buffer changes.
	const rmsEnv = useMemo(
		() => (buffer ? buildRmsEnvelope(buffer) : null),
		[buffer],
	);
	// Denoise the AI cuts before they become segments: swallow the tiny one-word
	// green islands Gemini sometimes strands between two cuts (Andy saw them
	// ~twice/video) so they don't blip the transcript/waveform or stutter skip-cuts
	// playback. Runs on the fresh analysis only — no manual locks exist yet, so it
	// never overrides hand edits. Pure + unit-tested (final-pass-denoise.test.ts).
	const denoisedCuts = useMemo(
		() =>
			analysis ? mergeShortKeepIslands({ cuts: analysis.cuts, segments }) : [],
		[analysis, segments],
	);
	const seedCutRanges = useMemo<SilenceRange[]>(() => {
		const ratio = bufDur > 0 && medDur > 0 ? bufDur / medDur : 1;
		return denoisedCuts.map((c) => {
			const rawStart = c.start * ratio;
			const rawEnd = c.end * ratio;
			if (!rmsEnv) return { startSec: rawStart, endSec: rawEnd };
			// Snap each boundary to the nearest audio minimum (never cut on a peak).
			const startSec = snapToQuietest(rmsEnv, rawStart);
			let endSec = snapToQuietest(rmsEnv, rawEnd);
			// Guard against the two boundaries snapping to the same valley.
			if (endSec <= startSec) endSec = rawEnd;
			return { startSec, endSec };
		});
	}, [denoisedCuts, bufDur, medDur, rmsEnv]);

	// Restore Andy's manual keep/cut edits from a prior session (read once at
	// mount, synchronously, so it can seed the segment model's initial state —
	// otherwise a reload wipes his hand-marking). Keyed by asset id.
	const initialSegState = useMemo(
		() => readSegmentsCache(asset.id),
		[asset.id],
	);

	const cutModel = useRawCutSegments({
		cutRanges: seedCutRanges,
		bufferDuration: bufDur,
		mediaDuration: medDur,
		currentTime,
		seekTo: handleSeek,
		skipSeek,
		initial: initialSegState ?? undefined,
		// Re-analyze re-suggests only in clips Andy hasn't touched; his manual
		// keep/cut edits survive, so the Teach-from-edit diff stays meaningful.
		preserveManualEdits: true,
	});

	// Persist on every segment change so a refresh never drops his work.
	// exportState's identity changes whenever the segments change, so this fires
	// on each edit (and once on mount to capture the AI's initial cuts).
	const exportSegState = cutModel.exportState;
	useEffect(() => {
		writeSegmentsCache(asset.id, exportSegState());
	}, [asset.id, exportSegState]);

	// Current cut ranges in MEDIA seconds — the transcript is timed in media
	// seconds (the waveform consumes the buffer-time ranges directly).
	const b2m = bufDur > 0 && medDur > 0 ? medDur / bufDur : 1;
	const cutRangesMedia = useMemo(
		() =>
			cutModel.displayCutRanges.map((r) => ({
				start: r.startSec * b2m,
				end: r.endSec * b2m,
			})),
		[cutModel.displayCutRanges, b2m],
	);
	const cutCount = cutModel.displayCutRanges.length;

	// Keep the rAF playback loop's cut-skip pointed at the current model.
	onPlaybackTickRef.current = cutModel.onPlaybackTick;

	// A/D — jump prev/next RED (cut) clip so Andy can hop cut-to-cut to inspect
	// and fix boundaries. (Green-clip nav was the old A/D; preview playback now
	// covers "play the keeps".) Segments are buffer-time; seek in media (b2m),
	// landing a hair inside the clip so the selection is the cut in front.
	const seekIntoSegMedia = useCallback(
		(s: { startSec: number; endSec: number }) => {
			const into = s.startSec + Math.min(0.02, (s.endSec - s.startSec) / 2);
			handleSeek(into * b2m);
		},
		[b2m, handleSeek],
	);
	const gotoNextRed = useCallback(() => {
		const segs = cutModel.segments;
		for (let i = cutModel.currentIndex + 1; i < segs.length; i++) {
			if (segs[i].status === "cut") return seekIntoSegMedia(segs[i]);
		}
	}, [cutModel.segments, cutModel.currentIndex, seekIntoSegMedia]);
	const gotoPrevRed = useCallback(() => {
		const segs = cutModel.segments;
		for (let i = cutModel.currentIndex - 1; i >= 0; i--) {
			if (segs[i].status === "cut") return seekIntoSegMedia(segs[i]);
		}
	}, [cutModel.segments, cutModel.currentIndex, seekIntoSegMedia]);

	// Chapter pins for the waveform (media timebase = chapter.time). Memoized so
	// the waveform's draw effect only re-runs when the chapters actually change.
	const chapterMarkers = useMemo(
		() => chapters.map((c) => ({ sec: c.time, title: c.title })),
		[chapters],
	);
	// Purple feedback pins for the waveform (media timebase = marker.time).
	const feedbackMarkers = useMemo(
		() => feedback.map((f) => ({ sec: f.time, title: f.note })),
		[feedback],
	);

	// Kept (final) runtime if the current cuts are applied — drives the
	// "30:01 → 24:18" readout and the Send-to-editor button.
	const fullSec = asset.duration ?? medDur;
	const keptSec = useMemo(() => {
		const cut = cutRangesMedia.reduce((sum, r) => sum + (r.end - r.start), 0);
		return Math.max(0, (medDur || 0) - cut);
	}, [cutRangesMedia, medDur]);

	// "Send to editor" — materialize the kept clips onto the edit timeline
	// (silences rippled out, cut footage recoverable via clip trims) and flip to
	// Edit mode. Same non-destructive path Raw Cut uses, fed by Final Pass's cuts.
	const sendToEdit = useCallback(() => {
		if (!buffer) return;
		try {
			const result = sendRawCutToTimeline({
				editor,
				mediaId: asset.id,
				mediaName: asset.name,
				segments: cutModel.segments,
				bufferDuration: buffer.duration,
				mediaDuration: mediaDuration ?? asset.duration ?? buffer.duration,
			});
			if (result.keptClips === 0) {
				toast.error("Nothing to send — every clip is cut.");
				return;
			}
			toast.success(
				`Sent ${result.keptClips} clip${result.keptClips === 1 ? "" : "s"} · ${formatClock(fullSec)} → ${formatClock(result.keptSec)} to the timeline.`,
			);
			setMode("edit");
		} catch (err) {
			toast.error(`Send to editor failed: ${(err as Error).message}`);
		}
	}, [
		buffer,
		editor,
		asset.id,
		asset.name,
		asset.duration,
		cutModel.segments,
		mediaDuration,
		fullSec,
		setMode,
	]);

	// Part B v2 — intercept "Send to editor" to TEACH from this edit first.
	// Snapshot the before→after diff (AI cuts vs Andy's final keep/cut) + purple
	// notes; if there's something to learn AND a Gemini key, open the Teach dialog
	// and send on close. Nothing to learn (or no key) → send straight through.
	const [teachInput, setTeachInput] = useState<{
		diff: CutDiff;
		notes: string[];
	} | null>(null);
	const [teachOpen, setTeachOpen] = useState(false);

	const handleSendClick = useCallback(() => {
		const k = bufDur > 0 ? medDur / bufDur : 1;
		const diff = computeCutDiff({
			aiCuts: (analysis?.cuts ?? []).map((c) => ({
				start: c.start,
				end: c.end,
			})),
			segments: cutModel.segments,
			k,
			transcript: segments,
		});
		const notes = feedback.map((m) => m.note);
		const learnable =
			diff.overCuts.length > 0 || diff.misses.length > 0 || notes.length > 0;
		if (learnable && getStoredKey("gemini")) {
			setTeachInput({ diff, notes });
			setTeachOpen(true);
		} else {
			sendToEdit();
		}
	}, [
		analysis,
		bufDur,
		medDur,
		cutModel.segments,
		segments,
		feedback,
		sendToEdit,
	]);

	// Per-transcript-line cut state. A line is red if it overlaps a cut segment;
	// the first line of each cut run is the "anchor" that shows the AI's reason
	// (looked up from the original analysis cuts) so the why-it-was-cut survives.
	const segCuts = useMemo<
		Array<{ isCut: boolean; anchor: boolean; reason: string }>
	>(() => {
		const reasons = analysis?.cuts ?? [];
		let prevCut = false;
		return segments.map((s) => {
			const isCut = cutRangesMedia.some(
				(r) => s.start < r.end && s.end > r.start,
			);
			const anchor = isCut && !prevCut;
			prevCut = isCut;
			let reason = "";
			if (anchor) {
				const c = reasons.find((c) => s.start < c.end && s.end > c.start);
				if (c) reason = `${c.kind}: ${c.reason}`;
			}
			return { isCut, anchor, reason };
		});
	}, [segments, cutRangesMedia, analysis]);

	// (Keymap is wired below, after the chapter + feedback handlers it binds M/N to.)

	// --- Step 4: the chatbot. It returns the NEW (post-mutation) ACTIVE cut list
	// + score, so we adopt them wholesale and clear the manual keep-set (it's
	// folded into the array). Transcript + timeline re-render from analysis.cuts. ---
	const applyChatResult = useCallback(
		(data: {
			reply?: string;
			cuts?: Cut[];
			score?: number;
			projectedScore?: number | null;
			toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
		}) => {
			const mutatedCuts = Array.isArray(data.cuts);
			const mutatedScore = typeof data.score === "number";
			if (mutatedCuts || mutatedScore) {
				setAnalysis((prev) => {
					const baseline: Analysis = prev ?? {
						score: 0,
						verdict: "not-greenlit",
						reason: "",
						cuts: [],
					};
					const score = mutatedScore ? (data.score as number) : baseline.score;
					return {
						...baseline,
						score,
						verdict: score >= GREENLIT_CUTOFF ? "greenlit" : "not-greenlit",
						cuts: mutatedCuts ? (data.cuts as Cut[]) : baseline.cuts,
					};
				});
			}
			if (data.projectedScore != null) setProjectedScore(data.projectedScore);
			if (data.reply) {
				setChatMessages((prev) => [
					...prev,
					{
						id: nextChatMsgId(),
						role: "assistant",
						content: data.reply as string,
						toolCalls: data.toolCalls,
					},
				]);
			}
		},
		[],
	);

	// Open the chat with the AI's opening verdict (score now + projected + why).
	const chatInit = useCallback(
		async (a: Analysis) => {
			setChatOpen(true);
			setChatMessages([]);
			setProjectedScore(null);
			setChatError(null);
			setChatLoading(true);
			try {
				const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
				const res = await fetch(`${base}/api/final-pass/chat`, {
					method: "POST",
					headers: { "Content-Type": "application/json", ...geminiHeaders() },
					body: JSON.stringify({
						mode: "init",
						segments,
						cuts: a.cuts,
						score: a.score,
					}),
				});
				if (!res.ok) {
					const d = (await res.json().catch(() => null)) as {
						error?: string;
					} | null;
					throw new Error(d?.error ?? `Request failed (${res.status})`);
				}
				applyChatResult(await res.json());
			} catch (err) {
				setChatError((err as Error).message);
			} finally {
				setChatLoading(false);
			}
		},
		[segments, applyChatResult],
	);

	const sendChat = useCallback(
		async (text: string) => {
			if (!analysis) return;
			const userMsg: FinalPassChatMessage = {
				id: nextChatMsgId(),
				role: "user",
				content: text,
			};
			// History for the model = prior turns (text only) + this one.
			const history = [...chatMessages, userMsg].map((m) => ({
				role: m.role,
				content: m.content,
			}));
			setChatMessages((prev) => [...prev, userMsg]);
			setChatError(null);
			setChatLoading(true);
			try {
				const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
				const res = await fetch(`${base}/api/final-pass/chat`, {
					method: "POST",
					headers: { "Content-Type": "application/json", ...geminiHeaders() },
					body: JSON.stringify({
						mode: "chat",
						messages: history,
						segments,
						// Send Andy's CURRENT (hand-edited) cuts so the bot reasons about
						// what's actually cut, not just its original suggestions.
						cuts: cutRangesMedia.map((r) => ({
							start: r.start,
							end: r.end,
							reason: "",
							kind: "fluff" as const,
						})),
						score: analysis.score,
					}),
				});
				if (!res.ok) {
					const d = (await res.json().catch(() => null)) as {
						error?: string;
					} | null;
					throw new Error(d?.error ?? `Request failed (${res.status})`);
				}
				applyChatResult(await res.json());
			} catch (err) {
				setChatError((err as Error).message);
			} finally {
				setChatLoading(false);
			}
		},
		[analysis, chatMessages, segments, cutRangesMedia, applyChatResult],
	);

	// "Red-cut the fluff" → run the analysis (or restore cache), then pop the
	// chat with the opening verdict. The merged Step 3 + Step 4 entry point.
	const redCutAndChat = useCallback(
		async (opts?: { force?: boolean }) => {
			const a = await analyze(opts);
			if (a) await chatInit(a);
		},
		[analyze, chatInit],
	);

	// Re-open the chat panel without re-billing; kick off the opening verdict if
	// it was never generated (e.g. analysis restored from cache on mount).
	const openChat = useCallback(() => {
		setChatOpen(true);
		if (chatMessages.length === 0 && analysis && !chatLoading) {
			void chatInit(analysis);
		}
	}, [chatMessages.length, analysis, chatLoading, chatInit]);

	// --- Chapters (Step/section markers for the description) ---------------------
	// Persist on every mutation so Andy's title/time edits survive a reload.
	const commitChapters = useCallback(
		(next: Chapter[]) => {
			setChapters(next);
			if (segments.length > 0 && contentHash) {
				writeChaptersCache({
					contentHash,
					transcriptHash: hashTranscript(segments),
					chapters: next,
				});
			}
		},
		[contentHash, segments],
	);

	const detectChapters = useCallback(async () => {
		if (segments.length === 0) return;
		setChaptersDetecting(true);
		setChaptersError(null);
		try {
			const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
			const res = await fetch(`${base}/api/final-pass/chapters`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...geminiHeaders() },
				body: JSON.stringify({ segments }),
			});
			if (!res.ok) {
				const d = (await res.json().catch(() => null)) as {
					error?: string;
				} | null;
				throw new Error(d?.error ?? `Request failed (${res.status})`);
			}
			const data = (await res.json()) as { chapters?: Chapter[] };
			commitChapters(
				(Array.isArray(data.chapters) ? data.chapters : []).map((c) => ({
					...c,
					id: nextChapterId(),
				})),
			);
		} catch (err) {
			setChaptersError((err as Error).message);
		} finally {
			setChaptersDetecting(false);
		}
	}, [segments, commitChapters]);

	const renameChapter = useCallback(
		(index: number, title: string) =>
			commitChapters(
				chapters.map((c, i) => (i === index ? { ...c, title } : c)),
			),
		[chapters, commitChapters],
	);
	const retimeChapterToPlayhead = useCallback(
		(index: number) =>
			commitChapters(
				chapters
					.map((c, i) => (i === index ? { ...c, time: currentTime } : c))
					.sort((a, b) => a.time - b.time),
			),
		[chapters, currentTime, commitChapters],
	);
	const deleteChapter = useCallback(
		(index: number) => {
			if (chapters[index]?.id === editingChapterId) setEditingChapterId(null);
			commitChapters(chapters.filter((_, i) => i !== index));
		},
		[chapters, commitChapters, editingChapterId],
	);
	// M — drop a chapter at the playhead and open its inline editor at the pin.
	const addChapterAtPlayhead = useCallback(() => {
		const id = nextChapterId();
		commitChapters(
			[...chapters, { id, time: currentTime, title: "New chapter" }].sort(
				(a, b) => a.time - b.time,
			),
		);
		setEditingChapterId(id);
		setEditingFeedbackId(null);
	}, [chapters, currentTime, commitChapters]);
	const copyChaptersForDescription = useCallback(() => {
		const text = chapters
			.slice()
			.sort((a, b) => a.time - b.time)
			.map((c) => `${formatClock(c.time)} ${c.title}`)
			.join("\n");
		void navigator.clipboard?.writeText(text).then(
			() => {
				setCopiedChapters(true);
				window.setTimeout(() => setCopiedChapters(false), 1500);
			},
			() => setChaptersError("Couldn't copy to clipboard."),
		);
	}, [chapters]);

	// Re-time a chapter to an arbitrary second — the commit path for dragging its
	// blue pin on the waveform (the ⌖ button re-times to the playhead instead).
	const retimeChapterTo = useCallback(
		(index: number, sec: number) =>
			commitChapters(
				chapters
					.map((c, i) => (i === index ? { ...c, time: sec } : c))
					.sort((a, b) => a.time - b.time),
			),
		[chapters, commitChapters],
	);

	// --- Feedback markers (purple pins) -----------------------------------------
	// Persist on every mutation so the notes survive a reload (asset-id keyed).
	const commitFeedback = useCallback(
		(next: FeedbackMarker[]) => {
			setFeedback(next);
			writeFeedbackCache(asset.id, next);
		},
		[asset.id],
	);
	// N — drop a purple marker at the playhead (note pre-filled "MM:SS - ") and open
	// its inline editor at the pin so Andy can type the note immediately.
	const addFeedbackAtPlayhead = useCallback(() => {
		const id = nextFeedbackId();
		commitFeedback(
			[
				...feedback,
				{ id, time: currentTime, note: `${formatClock(currentTime)} - ` },
			].sort((a, b) => a.time - b.time),
		);
		setEditingFeedbackId(id);
		setEditingChapterId(null);
	}, [feedback, currentTime, commitFeedback]);
	const renameFeedback = useCallback(
		(index: number, note: string) =>
			commitFeedback(
				feedback.map((f, i) => (i === index ? { ...f, note } : f)),
			),
		[feedback, commitFeedback],
	);
	// Re-time a marker (drag commit). Keeps the "MM:SS - " prefix in the note in
	// sync with the new time, but only if it's still the auto-prefix (never clobbers
	// text Andy typed over it).
	const retimeFeedbackTo = useCallback(
		(index: number, sec: number) =>
			commitFeedback(
				feedback
					.map((f, i) =>
						i === index
							? { ...f, time: sec, note: retimeNotePrefix(f.note, sec) }
							: f,
					)
					.sort((a, b) => a.time - b.time),
			),
		[feedback, commitFeedback],
	);
	const deleteFeedback = useCallback(
		(index: number) => {
			const victim = feedback[index];
			if (victim?.id === editingFeedbackId) setEditingFeedbackId(null);
			commitFeedback(feedback.filter((_, i) => i !== index));
		},
		[feedback, commitFeedback, editingFeedbackId],
	);
	// Index the waveform's inline editor should open (or null). Tracked by id so it
	// survives the re-sort that retime/add can trigger.
	const editingFeedbackIndex = useMemo(() => {
		if (!editingFeedbackId) return null;
		const i = feedback.findIndex((f) => f.id === editingFeedbackId);
		return i < 0 ? null : i;
	}, [editingFeedbackId, feedback]);
	const editingChapterIndex = useMemo(() => {
		if (!editingChapterId) return null;
		const i = chapters.findIndex((c) => c.id === editingChapterId);
		return i < 0 ? null : i;
	}, [editingChapterId, chapters]);

	// Full Raw Cut editing keymap over the segment model. Defined here (not earlier)
	// so it can bind M/N to the chapter + feedback handlers above.
	useFinalPassKeybindings({
		playPause: togglePlay,
		zoomIn,
		zoomOut,
		setSpeed,
		speedUp,
		pause: pausePlayback,
		stepFrames,
		jumpSeconds,
		toggleCurrent: cutModel.toggleCurrent,
		togglePrev: cutModel.togglePrev,
		toggleNext: cutModel.toggleNext,
		togglePrevGreen: cutModel.togglePrevGreen,
		toggleNextGreen: cutModel.toggleNextGreen,
		cycleAndAdvance: cutModel.cycleAndAdvance,
		sweepForward: cutModel.sweepForward,
		toggleLock: cutModel.toggleLock,
		addChapter: addChapterAtPlayhead,
		addFeedback: addFeedbackAtPlayhead,
		split: cutModel.splitHere,
		unwind: cutModel.unwind,
		nextCut: gotoNextRed,
		prevCut: gotoPrevRed,
		nextBoundary: cutModel.gotoNextBoundary,
		prevBoundary: cutModel.gotoPrevBoundary,
		undo: cutModel.undo,
		redo: cutModel.redo,
		toggleSkipCuts: () => setSkipCuts((v) => !v),
	});

	// Restore cached chapters once the transcript is ready (mirrors the analysis
	// restore). Re-ids them so React keys stay stable through edits.
	useEffect(() => {
		if (
			!ready ||
			segments.length === 0 ||
			chapters.length > 0 ||
			!contentHash
		) {
			return;
		}
		const hit = readChaptersCache({
			contentHash,
			transcriptHash: hashTranscript(segments),
		});
		if (hit && hit.length > 0) {
			setChapters(hit.map((c) => ({ ...c, id: c.id ?? nextChapterId() })));
		}
	}, [ready, segments, chapters.length, contentHash]);

	// Active line = the most recent segment whose start has passed. Drives the
	// highlight and the auto-scroll.
	const activeIndex = useMemo(() => {
		if (!ready) return -1;
		let idx = -1;
		for (let i = 0; i < segments.length; i++) {
			if (currentTime >= segments[i].start) idx = i;
			else break;
		}
		return idx;
	}, [ready, segments, currentTime]);

	// Pin the currently-spoken line to the TOP of the transcript as it reads
	// along. Manual scrollTop delta (not scrollIntoView, which would also scroll
	// the page/player) so ONLY the transcript list moves — and never to the
	// bottom.
	const listRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (activeIndex < 0) return;
		const list = listRef.current;
		const el = list?.querySelector<HTMLElement>('[data-active="true"]');
		if (!list || !el) return;
		const elRect = el.getBoundingClientRect();
		const listRect = list.getBoundingClientRect();
		list.scrollTop += elRect.top - listRect.top;
	}, [activeIndex]);

	// (No stick-to-bottom while transcribing — never force-scroll the transcript
	// to the bottom. Cloud Scribe returns all lines at once anyway.)

	const busy = isBusy(status);
	const greenlit = !!analysis && analysis.score >= GREENLIT_CUTOFF;
	// Transcription reuses the bottom waveform's decoded buffer; clicking before
	// it's ready forces a flaky fresh decode (the error Andy hit). Hold the button
	// until the buffer is decoded. If the decode errored, fall through and let the
	// fresh-decode fallback try (it surfaces its own error).
	const waveformPending = decoding || (!buffer && !decodeErr);

	return (
		<div className="flex h-full w-full flex-col">
			<div className="flex shrink-0 items-center justify-between border-b px-4 py-2">
				<div className="flex items-baseline gap-4 text-sm">
					<div>
						<span className="text-muted-foreground">Loaded:</span>{" "}
						<span className="text-foreground font-medium">{asset.name}</span>
					</div>
					<span className="text-muted-foreground text-xs">
						{formatDuration(asset.duration)}
					</span>
				</div>
				<div className="flex items-center gap-3">
					{analysis && (
						<span
							className={cn(
								"rounded px-2 py-0.5 text-sm font-semibold tabular-nums",
								greenlit
									? "bg-green-500/20 text-green-500"
									: "bg-yellow-500/20 text-yellow-500",
							)}
							title="AI Final Pass score (the chat owns it)"
						>
							{analysis.score.toFixed(1)}/10
						</span>
					)}
					{analysis && !chatOpen && (
						<Button variant="outline" size="sm" onClick={openChat}>
							Open chat
						</Button>
					)}
					<Button variant="ghost" size="sm" onClick={onChange}>
						Change clip
					</Button>
					{/* Live final-runtime delta + the export. This is the finish line. */}
					{cutCount > 0 && (
						<span
							className="rounded bg-muted px-2 py-0.5 text-xs tabular-nums"
							title="Original runtime → final runtime after the cuts"
						>
							{formatClock(fullSec)} →{" "}
							<span className="text-green-500 font-semibold">
								{formatClock(keptSec)}
							</span>
						</span>
					)}
					<Button
						size="sm"
						onClick={handleSendClick}
						disabled={!buffer || cutModel.segments.length === 0}
						title="Drop the kept clips onto the edit timeline (non-destructive) and switch to Edit"
					>
						Send to editor →
					</Button>
				</div>
			</div>

			<div className="flex min-h-0 flex-1">
				<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 py-4">
					<div
						className="order-1 flex shrink-0 items-center justify-center"
						style={{ height: playerH }}
					>
						{asset.type === "video" && asset.url ? (
							// biome-ignore lint/a11y/useMediaCaption: final-pass preview, captions live downstream
							<video
								ref={(el) => {
									mediaRef.current = el;
								}}
								src={asset.url}
								controls
								preload="metadata"
								className="max-h-full max-w-full rounded bg-black"
								onLoadedMetadata={(e) => {
									const el = e.target as HTMLVideoElement;
									el.defaultPlaybackRate = speedRef.current;
									el.playbackRate = speedRef.current;
									const d = el.duration;
									if (Number.isFinite(d) && d > 0) setMediaDuration(d);
								}}
								onPlay={(e) => {
									const el = e.target as HTMLVideoElement;
									setIsPlaying(true);
									el.playbackRate = speedRef.current;
									// Start inside a cut → play THROUGH it (only green→red
									// crossings skip after this point).
									playThroughUntilRef.current = cutRunEndMediaSec({
										segments: cutModel.segments,
										mediaSec: el.currentTime,
										k: b2m,
									});
								}}
								onPause={() => setIsPlaying(false)}
								onTimeUpdate={(e) =>
									setCurrentTime((e.target as HTMLVideoElement).currentTime)
								}
							/>
						) : asset.type === "audio" && asset.url ? (
							// biome-ignore lint/a11y/useMediaCaption: raw audio preview
							<audio
								ref={(el) => {
									mediaRef.current = el;
								}}
								src={asset.url}
								controls
								className="w-full max-w-3xl"
								onLoadedMetadata={(e) => {
									const el = e.target as HTMLAudioElement;
									el.defaultPlaybackRate = speedRef.current;
									el.playbackRate = speedRef.current;
									const d = el.duration;
									if (Number.isFinite(d) && d > 0) setMediaDuration(d);
								}}
								onPlay={(e) => {
									const el = e.target as HTMLAudioElement;
									setIsPlaying(true);
									el.playbackRate = speedRef.current;
									// Start inside a cut → play THROUGH it (only green→red
									// crossings skip after this point).
									playThroughUntilRef.current = cutRunEndMediaSec({
										segments: cutModel.segments,
										mediaSec: el.currentTime,
										k: b2m,
									});
								}}
								onPause={() => setIsPlaying(false)}
								onTimeUpdate={(e) =>
									setCurrentTime((e.target as HTMLAudioElement).currentTime)
								}
							/>
						) : (
							<div className="text-muted-foreground rounded border p-4 text-sm">
								Clip loaded. Preview unavailable.
							</div>
						)}
					</div>

					{/* Drag to resize the preview. */}
					<div
						className="group order-1 flex h-3 shrink-0 cursor-row-resize items-center justify-center"
						onPointerDown={onPlayerResizeDown}
						onPointerMove={onPlayerResizeMove}
						onPointerUp={onPlayerResizeUp}
						title="Drag to resize the player"
					>
						<div className="bg-border group-hover:bg-muted-foreground h-1 w-16 rounded-full transition-colors" />
					</div>

					<div className="order-2 flex shrink-0 flex-wrap items-center justify-between gap-3">
						<div className="text-muted-foreground text-xs">
							<TranscribeStatusLine
								status={status}
								device={device}
								elapsedSec={elapsedSec}
							/>
							{analyzeBusy && (
								<span className="text-foreground ml-2">
									· Analyzing… {formatElapsed(analyzeElapsedSec)}
								</span>
							)}
							{analyzeError && (
								<span className="text-destructive ml-2">⚠ {analyzeError}</span>
							)}
							{cutCount > 0 && (
								<span className="ml-2">
									·{" "}
									<span className="text-red-400">
										{cutCount} {cutCount === 1 ? "cut" : "cuts"}
									</span>
								</span>
							)}
						</div>
						<div className="flex items-center gap-2">
							{teachInput && (
								<FinalPassTeach
									open={teachOpen}
									onClose={() => {
										setTeachOpen(false);
										sendToEdit();
									}}
									diff={teachInput.diff}
									notes={teachInput.notes}
									geminiKey={getStoredKey("gemini") || null}
								/>
							)}
							<FinalPassRulebook />
							<FinalPassKeys />
							{ready && (
								<Button
									variant="ghost"
									size="sm"
									onClick={() => void transcribe()}
								>
									Re-transcribe
								</Button>
							)}
							{!ready && (
								<Button
									size="sm"
									onClick={() => void transcribe()}
									disabled={busy || waveformPending}
								>
									{busy
										? "Working…"
										: waveformPending
											? "Decoding audio…"
											: "Transcribe"}
								</Button>
							)}
							{ready && (
								<Button
									// First run = prominent primary. Once an analysis exists,
									// dark/secondary so Re-analyze (re-bills Gemini) isn't a
									// one-click foot-gun. Matches the Skip-cuts off-state.
									variant={analysis ? "outline" : "default"}
									size="sm"
									onClick={() => void redCutAndChat({ force: !!analysis })}
									disabled={analyzing || chatLoading}
									title={
										analysis
											? "Re-run the AI read + chat (re-bills Gemini)"
											: "Score it, analyze the fluff, and open the AI chat"
									}
								>
									{analyzing
										? "Analyzing…"
										: analysis
											? "Re-analyze"
											: "Analyze fluff"}
								</Button>
							)}
							{ready && (
								<Button
									variant="outline"
									size="sm"
									onClick={() => void detectChapters()}
									disabled={chaptersDetecting}
									title="Detect chapter/step markers for the description"
								>
									{chaptersDetecting
										? "Detecting…"
										: chapters.length > 0
											? "Re-detect chapters"
											: "Detect chapters"}
								</Button>
							)}
						</div>
					</div>

					<div
						ref={listRef}
						className="order-5 h-[22rem] shrink-0 overflow-y-auto rounded border"
					>
						{segments.length === 0 ? (
							<div className="text-muted-foreground flex h-full items-center justify-center p-6 text-center text-sm">
								{busy
									? "Listening…"
									: "Hit Transcribe to read along. It’s instant if Raw Cut already transcribed this clip."}
							</div>
						) : (
							<div className="flex flex-col">
								{segments.map((seg, i) => {
									const active = i === activeIndex;
									const ci = segCuts[i];
									const isCut = ci.isCut;
									return (
										<button
											key={`${seg.start}-${seg.end}`}
											type="button"
											data-active={active}
											disabled={!ready}
											onClick={ready ? () => handleSeek(seg.start) : undefined}
											className={cn(
												"flex w-full items-baseline gap-3 px-3 py-1.5 text-left text-sm transition-colors",
												isCut
													? "bg-red-500/10 text-red-400"
													: "text-muted-foreground",
												active && "bg-primary/15",
												ready && "hover:opacity-80",
											)}
										>
											<span className="text-muted-foreground w-12 shrink-0 tabular-nums text-xs">
												{ready ? formatClock(seg.start) : "···"}
											</span>
											<span className="min-w-0 flex-1">
												{seg.text.trim()}
												{ci.anchor && ci.reason && (
													<span className="text-red-400/80 ml-2 text-xs italic">
														— {ci.reason}
													</span>
												)}
											</span>
										</button>
									);
								})}
							</div>
						)}
					</div>

					{/* Timeline controls — speed shuttle + zoom (mirrors Raw Cut). */}
					<div className="order-3 flex shrink-0 items-center justify-between">
						<div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
							{cutModel.current && (
								<span
									className={cn(
										"rounded px-1.5 py-0.5 font-medium tabular-nums",
										cutModel.current.status === "keep"
											? "bg-green-500/20 text-green-500"
											: "bg-red-500/20 text-red-400",
									)}
								>
									clip {cutModel.currentIndex + 1}/{cutModel.segments.length} ·{" "}
									{cutModel.current.status === "keep" ? "KEEP" : "CUT"}
									{cutModel.current.locked ? " · 🔒" : ""}
								</span>
							)}
							<kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono">
								Q/W/E
							</kbd>
							<span>keep/cut</span>
							<span className="opacity-50">·</span>
							<kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono">
								O
							</kbd>
							<span>cut+next</span>
							<span className="opacity-50">·</span>
							<kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono">
								S
							</kbd>
							<span>split</span>
							<span className="opacity-50">·</span>
							<kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono">
								M
							</kbd>
							<span>chapter</span>
							<span className="opacity-50">·</span>
							<kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono">
								N
							</kbd>
							<span>note</span>
							<span className="opacity-50">·</span>
							<kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono">
								A/D
							</kbd>
							<span>cut</span>
							<span className="opacity-50">·</span>
							<kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono">
								Space
							</kbd>
							<span>play</span>
							{speedState !== 1 && (
								<span className="ml-1 rounded bg-yellow-500/20 px-1.5 py-0.5 font-medium text-yellow-500 tabular-nums">
									{speedState}×
								</span>
							)}
						</div>
						<div className="flex items-center gap-1">
							<Button
								variant={skipCuts ? "default" : "outline"}
								size="sm"
								className="h-6 px-2 text-xs"
								onClick={() => setSkipCuts((v) => !v)}
								title={
									skipCuts
										? "Playback skips red cuts — you're previewing the final edit (C)"
										: "Playback plays the whole clip, including cuts (C)"
								}
							>
								{skipCuts ? "⏭ Skip cuts" : "▶ Play all"}
							</Button>
							<span className="mx-1 opacity-30">|</span>
							<Button
								variant={speedState === 1 ? "default" : "outline"}
								size="sm"
								className="h-6 px-2 text-xs"
								onClick={() => setSpeed(1)}
							>
								1×
							</Button>
							<Button
								variant={speedState === 2 ? "default" : "outline"}
								size="sm"
								className="h-6 px-2 text-xs"
								onClick={() => setSpeed(2)}
							>
								2×
							</Button>
							<Button
								variant={speedState === 3 ? "default" : "outline"}
								size="sm"
								className="h-6 px-2 text-xs"
								onClick={() => setSpeed(3)}
							>
								3×
							</Button>
							<span className="mx-1 opacity-30">|</span>
							<Button
								variant="outline"
								size="sm"
								className="h-6 w-6 p-0"
								onClick={zoomOut}
								disabled={zoom <= 1}
								aria-label="Zoom out (Z)"
							>
								−
							</Button>
							<span className="text-muted-foreground w-12 text-center text-xs tabular-nums">
								{zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}×
							</span>
							<Button
								variant="outline"
								size="sm"
								className="h-6 w-6 p-0"
								onClick={zoomIn}
								disabled={zoom >= ZOOM_MAX}
								aria-label="Zoom in (X)"
							>
								+
							</Button>
						</div>
					</div>

					{/* Waveform timeline. Green = keep, red bands = the active cuts —
				    the SAME source the transcript renders red, so they always match. */}
					<div className="order-4 h-32 shrink-0">
						{buffer ? (
							<RawCutWaveform
								buffer={buffer}
								silenceRanges={cutModel.displayCutRanges}
								// Lock ticks only — the mark/flag feature is gone in Final Pass
								// (M now drops a chapter; N a feedback note).
								markers={cutModel.markers.filter((m) => m.kind === "lock")}
								chapterMarkers={chapterMarkers}
								feedbackMarkers={feedbackMarkers}
								onChapterRetime={retimeChapterTo}
								onFeedbackRetime={retimeFeedbackTo}
								editingFeedbackIndex={editingFeedbackIndex}
								onFeedbackEditOpen={(i) => {
									setEditingFeedbackId(feedback[i]?.id ?? null);
									setEditingChapterId(null);
								}}
								onFeedbackNoteChange={renameFeedback}
								onFeedbackEditClose={() => setEditingFeedbackId(null)}
								onFeedbackDelete={deleteFeedback}
								editingChapterIndex={editingChapterIndex}
								onChapterEditOpen={(i) => {
									setEditingChapterId(chapters[i]?.id ?? null);
									setEditingFeedbackId(null);
								}}
								onChapterNoteChange={renameChapter}
								onChapterEditClose={() => setEditingChapterId(null)}
								onChapterDelete={deleteChapter}
								activeRange={
									cutModel.current
										? {
												startSec: cutModel.current.startSec,
												endSec: cutModel.current.endSec,
											}
										: undefined
								}
								currentTime={currentTime}
								durationSec={mediaDuration ?? asset.duration ?? undefined}
								zoom={zoom}
								onSeek={handleSeek}
								onZoomBy={zoomBy}
							/>
						) : (
							<div
								className={cn(
									"bg-muted/30 flex h-full items-center justify-center rounded border border-dashed text-xs",
									decodeErr ? "text-destructive" : "text-muted-foreground",
								)}
							>
								{decoding
									? `Decoding ${Math.round(decodeProgress * 100)}%…`
									: (decodeErr ?? "Waveform pending…")}
							</div>
						)}
					</div>

					{/* Chapters — verify titles/timings, then copy into the description. */}
					{(chapters.length > 0 || chaptersDetecting || chaptersError) && (
						<div className="order-6 shrink-0 rounded border text-xs">
							<div className="flex items-center justify-between gap-2 border-b px-2 py-1">
								<span className="font-medium">
									Chapters{chapters.length > 0 ? ` · ${chapters.length}` : ""}
									<span className="text-muted-foreground ml-1 font-normal">
										— blue pins on the timeline
									</span>
								</span>
								<div className="flex items-center gap-1">
									<Button
										variant="ghost"
										size="sm"
										className="h-6 px-2 text-xs"
										onClick={addChapterAtPlayhead}
										title="Add a chapter at the current playhead"
									>
										+ at playhead
									</Button>
									<Button
										variant="outline"
										size="sm"
										className="h-6 px-2 text-xs"
										onClick={copyChaptersForDescription}
										disabled={chapters.length === 0}
										title="Copy as YouTube description chapters"
									>
										{copiedChapters ? "Copied!" : "Copy for description"}
									</Button>
								</div>
							</div>
							{chaptersError && (
								<div className="text-destructive px-2 py-1">
									⚠ {chaptersError}
								</div>
							)}
							{chapters.length > 0 && (
								<div className="max-h-24 overflow-y-auto">
									{chapters.map((c, i) => (
										<div
											key={c.id ?? `${c.time}`}
											className="flex items-center gap-2 px-2 py-0.5"
										>
											<button
												type="button"
												onClick={() => handleSeek(c.time)}
												title="Seek here"
												className="text-muted-foreground hover:text-foreground w-12 shrink-0 text-left tabular-nums"
											>
												{formatClock(c.time)}
											</button>
											<input
												value={c.title}
												onChange={(e) => renameChapter(i, e.target.value)}
												className="bg-background focus:ring-ring min-w-0 flex-1 rounded border px-2 py-0.5 focus:outline-none focus:ring-1"
											/>
											<button
												type="button"
												onClick={() => retimeChapterToPlayhead(i)}
												title="Set this chapter's time to the current playhead"
												className="text-muted-foreground hover:text-foreground shrink-0"
											>
												⌖
											</button>
											<button
												type="button"
												onClick={() => deleteChapter(i)}
												title="Delete chapter"
												className="text-muted-foreground hover:text-destructive shrink-0"
											>
												✕
											</button>
										</div>
									))}
								</div>
							)}
						</div>
					)}
				</div>

				{chatOpen && analysis && (
					<FinalPassChat
						messages={chatMessages}
						loading={chatLoading}
						error={chatError}
						score={analysis.score}
						projectedScore={projectedScore}
						greenlit={greenlit}
						cutCount={cutCount}
						currentTime={currentTime}
						onSend={(t) => void sendChat(t)}
						onClose={() => setChatOpen(false)}
					/>
				)}
			</div>
		</div>
	);
}

function TranscribeStatusLine({
	status,
	device,
	elapsedSec,
}: {
	status: TranscribeStatus;
	device: "webgpu" | "wasm" | null;
	elapsedSec: number;
}) {
	const secs = formatElapsed(elapsedSec);
	switch (status.kind) {
		case "idle":
			return (
				<span>
					{device
						? "Model ready — hit Transcribe."
						: "Whisper runs in your browser — no upload."}
				</span>
			);
		case "preloading":
			return (
				<span>
					Warming up the model… {status.progress}%{" "}
					<span className="opacity-60">(one-time download)</span>
				</span>
			);
		case "decoding":
			return (
				<span>
					Preparing audio… {Math.round(status.progress * 100)}% · {secs}
				</span>
			);
		case "loading-model":
			return (
				<span>
					Downloading model… {status.progress}%{" "}
					<span className="opacity-60">(one-time)</span> · {secs}
				</span>
			);
		case "transcribing":
			return (
				<span>
					Transcribing… {status.lines} {status.lines === 1 ? "line" : "lines"} ·{" "}
					{secs}
				</span>
			);
		case "cloud":
			return (
				<span>
					Transcribing in the cloud… {secs}{" "}
					<span className="opacity-60">(ElevenLabs Scribe)</span>
				</span>
			);
		case "done":
			return (
				<span>
					{status.cached ? "Loaded from cache" : "Transcribed"} in{" "}
					{formatMs(status.durationMs)}
					{device ? ` · ${device === "webgpu" ? "GPU" : "CPU"}` : ""}
				</span>
			);
		case "error":
			return <span className="text-destructive">⚠ {status.message}</span>;
	}
}

function Thumb({ asset }: { asset: MediaAsset }) {
	if (asset.type === "video" && asset.thumbnailUrl) {
		return (
			<div className="bg-muted relative h-12 w-20 shrink-0 overflow-hidden rounded">
				<Image
					src={asset.thumbnailUrl}
					alt={asset.name}
					fill
					sizes="80px"
					unoptimized
					className="object-cover"
				/>
			</div>
		);
	}
	return <div className="bg-muted h-12 w-20 shrink-0 rounded" />;
}

function formatDuration(d?: number) {
	if (!d || !Number.isFinite(d)) return "—";
	const m = Math.floor(d / 60);
	const s = Math.floor(d % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

function formatClock(sec: number) {
	if (!Number.isFinite(sec)) return "0:00";
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

// Swap a leading "MM:SS - " timestamp prefix for the one at `newTime`. Leaves the
// note untouched if it doesn't start with the auto-prefix (Andy edited it away).
function retimeNotePrefix(note: string, newTime: number): string {
	return note.replace(/^\d+:\d{2} - /, `${formatClock(newTime)} - `);
}

function formatMs(ms: number) {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	const total = Math.round(ms / 1000);
	return `${Math.floor(total / 60)}m ${total % 60}s`;
}

// Count-up elapsed: "Xs" under a minute, "Xm Ys" above — so a long
// transcription reads "5m 40s", not "340s".
function formatElapsed(sec: number) {
	const s = Math.max(0, Math.floor(sec));
	if (s < 60) return `${s}s`;
	return `${Math.floor(s / 60)}m ${s % 60}s`;
}
