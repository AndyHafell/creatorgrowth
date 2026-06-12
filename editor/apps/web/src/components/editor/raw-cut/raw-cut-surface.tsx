"use client";

import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useEditor } from "@/hooks/use-editor";
import {
	DEFAULT_SILENCE_PARAMS,
	type SilenceDetectionParams,
	type SilenceRange,
	computeSilenceRanges,
	decodeMediaAssetForAnalysis,
} from "@/lib/media/audio";
import type { MediaAsset } from "@/lib/media/types";
import {
	type AiCutSuggestion,
	RAWCUT_CLOUD_MODEL_ID,
	parseImportedCuts,
	shouldApplyCut,
	transcriptCacheModelIds,
} from "@/lib/raw-cut/ai-cut";
import {
	type TranscriptWord,
	snapCutToWordGaps,
} from "@/lib/raw-cut/word-snap";
import {
	type LiveCommand,
	applyLiveCommand,
	parseLiveCommand,
} from "@/lib/raw-cut/live-cuts";
import { remapSegments, spliceKeepRegions } from "@/lib/raw-cut/audio-splice";
import {
	getMemoryBuffer,
	loadCachedAnalysisBuffer,
	storeCachedAnalysisBuffer,
} from "@/lib/raw-cut/decode-cache";
import {
	removeRawCutFromTimeline,
	sendRawCutToTimeline,
} from "@/lib/raw-cut/export-to-timeline";
import {
	type RawCutAiVerdict,
	getRawCutSession,
	patchRawCutSession,
} from "@/lib/raw-cut/session-cache";
import {
	elevenHeaders,
	geminiHeaders,
	getStoredKey,
} from "@/lib/final-pass/api-keys";
import {
	type Analysis,
	hashTranscript,
	readAnalysisCache,
	readRulebook,
	recallContentHash,
	rememberContentHash,
	writeAnalysisCache,
} from "../final-pass/final-pass-cache";
import {
	buildRmsEnvelope,
	encodeWav,
	snapToQuietest,
} from "../final-pass/final-pass-audio";
import { mergeShortKeepIslands } from "../final-pass/final-pass-denoise";
import {
	computeFileHash,
	readCachedTranscription,
	writeCachedTranscription,
} from "@/lib/raw-cut/transcription-cache";
import { DEFAULT_TRANSCRIPTION_SAMPLE_RATE } from "@/lib/transcription/audio";
import { DEFAULT_TRANSCRIPTION_MODEL } from "@/lib/transcription/models";
import { TRANSCRIPTION_MODELS } from "@/lib/transcription/models";
import type { TranscriptionSegment } from "@/lib/transcription/types";
import { transcriptionService } from "@/services/transcription/service";
import { useEditorModeStore } from "@/stores/editor-mode-store";
import { cn } from "@/utils/ui";
import { cutRunEndMediaSec } from "@/lib/raw-cut/segments";
import { DetectionKnobs } from "./detection-knobs";
import { RawCutWaveform } from "./raw-cut-waveform";
import { useRawCutKeybindings } from "./use-raw-cut-keybindings";
import { useRawCutSegments } from "./use-raw-cut-segments";
import { type DetectStatus, TranscriptionPanel } from "./transcription-panel";

// Waveform zoom bounds. Step matches the demo "feel" of the timeline Z/X.
const ZOOM_STEP = 1.7;
const ZOOM_MAX = 500;
// Max playback rate for the L shuttle / direct-speed keys.
const MAX_SPEED = 4;

export function RawCutSurface() {
	const mediaFiles = useEditor((e) => e.media.getAssets());
	const rawCutMediaId = useEditorModeStore((s) => s.rawCutMediaId);
	const openInRawCut = useEditorModeStore((s) => s.openInRawCut);
	const clearRawCutMedia = useEditorModeStore((s) => s.clearRawCutMedia);

	const cuttable = useMemo(
		() =>
			mediaFiles.filter(
				(m) => !m.ephemeral && (m.type === "video" || m.type === "audio"),
			),
		[mediaFiles],
	);

	const selected = useMemo(
		() => cuttable.find((m) => m.id === rawCutMediaId) ?? null,
		[cuttable, rawCutMediaId],
	);

	return (
		<div className="bg-background flex h-full w-full flex-col overflow-hidden">
			{selected ? (
				// Keyed by id so picking a different clip mounts a fresh component
				// (its state initializers re-read the cache for the new asset).
				<LoadedClip
					key={selected.id}
					asset={selected}
					onChange={clearRawCutMedia}
				/>
			) : (
				<ClipPicker clips={cuttable} onPick={openInRawCut} />
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
					Import a video or audio clip in Edit mode, then come back here to cut
					it.
				</div>
			</div>
		);
	}

	return (
		<div className="flex flex-1 flex-col items-center overflow-y-auto px-6 py-10">
			<div className="w-full max-w-2xl">
				<h2 className="text-foreground text-lg font-semibold">
					Pick a clip to cut
				</h2>
				<p className="text-muted-foreground mt-1 text-sm">
					Drop a long take in and Raw Cut will green/red the silences.
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

type DetectionStats = {
	silenceCount: number;
	silenceDurationSec: number;
	keepDurationSec: number;
	detectMs: number;
};

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

	// Snapshot of any prior session for THIS asset, taken once at mount. Used
	// only to seed the state initializers below (the component is keyed by
	// asset.id, so mount == this asset loading).
	const [initialSession] = useState(() => getRawCutSession(asset.id));

	// Buffer comes from the in-memory decode cache synchronously (mode-switch
	// round-trip); a reload falls through to the OPFS cache in the effect below.
	const [buffer, setBuffer] = useState<AudioBuffer | null>(
		() => getMemoryBuffer(asset.id) ?? null,
	);
	const [decodeMs, setDecodeMs] = useState<number | null>(
		() => initialSession?.decodeMs ?? null,
	);
	const [decodeErr, setDecodeErr] = useState<string | null>(null);
	const [decoding, setDecoding] = useState(false);
	const [decodeProgress, setDecodeProgress] = useState(0);

	const [params, setParams] = useState<SilenceDetectionParams>(
		() => initialSession?.params ?? DEFAULT_SILENCE_PARAMS,
	);
	const [silenceRanges, setSilenceRanges] = useState<SilenceRange[]>(
		() => initialSession?.silenceRanges ?? [],
	);
	const [stats, setStats] = useState<DetectionStats | null>(
		() => initialSession?.stats ?? null,
	);
	const [detecting, setDetecting] = useState(false);
	const [currentTime, setCurrentTime] = useState(
		() => initialSession?.currentTime ?? 0,
	);
	// Real playable duration from the media element — the authoritative timebase
	// for the playhead/seek (the 8kHz analysis buffer's duration drifts shorter).
	const [mediaDuration, setMediaDuration] = useState<number | null>(
		() => initialSession?.mediaDuration ?? null,
	);
	const [isPlaying, setIsPlaying] = useState(false);
	const [speedState, setSpeedState] = useState(
		() => initialSession?.speed ?? 1,
	);
	// Latest speed, readable from event handlers without a stale closure. The
	// media element silently resets playbackRate to defaultPlaybackRate on some
	// transitions (re-buffer / re-load), which is what dropped 2x/3x after a
	// pause→play — so we set BOTH and reassert on every play.
	const speedRef = useRef(initialSession?.speed ?? 1);
	// Waveform zoom: 1 = fit entire clip; Z/X step it (centered on playhead).
	const [zoom, setZoom] = useState(() => initialSession?.zoom ?? 1);
	// Restored playhead to seek the media element to once it's loaded (the UI
	// playhead is already restored via currentTime; this realigns the actual
	// video so playback resumes where Andy left off after a reload).
	const pendingSeekRef = useRef(initialSession?.currentTime ?? 0);

	// The AI content pass (Scribe transcript → Gemini cuts). Blue = suggested
	// cuts queued for Y/N review; high-confidence mechanical cuts auto-apply
	// into acceptedDoubleTakes (field name kept from the double-take era).
	const [detectStatus, setDetectStatus] = useState<DetectStatus>(() =>
		restoreDetectStatus(initialSession?.detectStatus),
	);
	const [device, setDevice] = useState<"webgpu" | "wasm" | null>(
		() => initialSession?.device ?? null,
	);
	const [suggestions, setSuggestions] = useState<AiCutSuggestion[]>(() =>
		// Guard: a pre-AI-cut session may restore old DoubleTakeSuggestion rows
		// (no kind/confidence) — drop those rather than render broken rows.
		(initialSession?.suggestions ?? []).filter(
			(s) => typeof (s as Partial<AiCutSuggestion>).kind === "string",
		),
	);
	const [acceptedDoubleTakes, setAcceptedDoubleTakes] = useState<
		SilenceRange[]
	>(() => initialSession?.acceptedDoubleTakes ?? []);
	const [aiVerdict, setAiVerdict] = useState<RawCutAiVerdict | null>(
		() => initialSession?.aiVerdict ?? null,
	);
	// Optional context for the AI pass (the video's outline / prep doc steps) —
	// lets the model tell a tangent from the actual point. Per-asset.
	const [outline, setOutline] = useState(() => initialSession?.outline ?? "");
	// Live cut channel (Claude Code pipeline): when set, this session polls the
	// channel and applies pushed commands directly — red or nothing.
	const [liveChannel, setLiveChannel] = useState<string | null>(
		() => initialSession?.liveChannel ?? null,
	);
	const detectRunIdRef = useRef(0);
	// Scribe word-level timings (media seconds) from the latest transcript —
	// snaps applied cut boundaries onto word gaps so a cut never clips a word
	// tail. In-memory only (too big for the localStorage session); after a
	// reload accepts fall back to the RMS snap until the next AI run.
	const wordsRef = useRef<TranscriptWord[] | null>(null);

	// Load the analysis buffer once on mount. Order: in-memory (already set via
	// initializer) → OPFS decode cache → full decode. Only the last path pays
	// the ~20s cost; the cache turns Edit↔Raw Cut round-trips and reloads into
	// an instant restore (Andy's top annoyance).
	// `params` + `asset` intentionally excluded — runs once per asset; manual
	// re-detects go through onUpdate.
	// biome-ignore lint/correctness/useExhaustiveDependencies: see comment
	useEffect(() => {
		// Already restored from the in-memory cache — nothing to decode.
		if (getMemoryBuffer(asset.id)) {
			setDecoding(false);
			return;
		}
		let cancelled = false;
		setDecodeErr(null);
		setDecoding(true);

		(async () => {
			try {
				// OPFS cache (survives reload): rebuild the buffer instantly.
				const cached = await loadCachedAnalysisBuffer(asset.id);
				if (cancelled) return;
				if (cached) {
					setBuffer(cached);
					setDecodeMs(0);
					// If the durable session already restored detection (and the
					// user's cuts on top of it), keep it — re-detecting would churn
					// the segment model. Only run a first pass for a fresh session.
					if (!initialSession?.silenceRanges?.length) {
						const t1 = performance.now();
						const ranges = computeSilenceRanges({ buffer: cached, params });
						if (cancelled) return;
						setSilenceRanges(ranges);
						setStats(
							computeStats({
								buffer: cached,
								ranges,
								detectMs: performance.now() - t1,
							}),
						);
					}
					return;
				}

				// Cold path: actually decode, then persist to both cache tiers.
				const t0 = performance.now();
				const buf = await decodeMediaAssetForAnalysis({
					asset,
					onProgress: (pct) => {
						if (!cancelled) setDecodeProgress(pct);
					},
				});
				if (cancelled) return;
				setDecodeMs(performance.now() - t0);
				if (!buf) {
					setDecodeErr("No audio track found in this clip.");
					return;
				}
				setBuffer(buf);
				void storeCachedAnalysisBuffer(asset.id, buf);

				const t1 = performance.now();
				const ranges = computeSilenceRanges({ buffer: buf, params });
				if (cancelled) return;
				setSilenceRanges(ranges);
				setStats(
					computeStats({
						buffer: buf,
						ranges,
						detectMs: performance.now() - t1,
					}),
				);
			} catch (err) {
				if (cancelled) return;
				setDecodeErr((err as Error).message);
			} finally {
				if (!cancelled) setDecoding(false);
			}
		})();

		return () => {
			cancelled = true;
		};
	}, [asset.id]);

	const runDetect = useCallback(() => {
		if (!buffer) return;
		setDetecting(true);
		// Defer to next frame so the "Updating…" label has time to paint.
		requestAnimationFrame(() => {
			const t0 = performance.now();
			const ranges = computeSilenceRanges({ buffer, params });
			const detectMs = performance.now() - t0;
			setSilenceRanges(ranges);
			setStats(computeStats({ buffer, ranges, detectMs }));
			setDetecting(false);
		});
	}, [buffer, params]);

	const handleSeek = useCallback((sec: number) => {
		const el = mediaRef.current;
		if (!el) return;
		el.currentTime = sec;
		setCurrentTime(sec);
	}, []);

	const togglePlay = useCallback(() => {
		const el = mediaRef.current;
		if (!el) return;
		if (el.paused) {
			void el.play();
		} else {
			el.pause();
		}
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

	// Playback rate (2x/3x review) — applied to the media element directly, not
	// the compositor playback-manager (which isn't mounted in Raw Cut).
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
	// Shift+A / Shift+D — jump ∓5s (review a clip's tail, then cut).
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

	// Combined cut ranges = auto-detected silences ∪ accepted double-takes.
	// These seed the editable segment model; manual toggles live in `seg`.
	const combinedCutRanges = useMemo(
		() => mergeRanges([...silenceRanges, ...acceptedDoubleTakes]),
		[silenceRanges, acceptedDoubleTakes],
	);

	const seg = useRawCutSegments({
		cutRanges: combinedCutRanges,
		bufferDuration: buffer?.duration ?? 0,
		mediaDuration: mediaDuration ?? asset.duration ?? buffer?.duration ?? 0,
		currentTime,
		seekTo: handleSeek,
		initial: initialSession?.segState,
	});
	const segCutRanges = seg.displayCutRanges;

	// When playback STARTS inside a cut Andy clicked into, this holds the
	// media-sec end of that cut run so the rAF loop plays THROUGH the red
	// instead of skipping it — only green→red crossings skip (same behavior as
	// Final Pass). Captured on the play event, cleared once the playhead passes.
	const playThroughUntilRef = useRef<number | null>(null);
	const capturePlayThrough = useCallback(
		(mediaSec: number) => {
			const bufDur = buffer?.duration ?? 0;
			const medDur = mediaDuration ?? asset.duration ?? bufDur;
			const k = bufDur > 0 ? medDur / bufDur : 1;
			playThroughUntilRef.current = cutRunEndMediaSec({
				segments: seg.segments,
				mediaSec,
				k,
			});
		},
		[buffer, mediaDuration, asset.duration, seg.segments],
	);

	// Playback loop (rAF, ~60fps): glides the centered playhead, keeps the
	// playback rate pinned (the media element silently drops it otherwise — the
	// 2x/3x persistence bug), and skips CUT (red) segments so we only ever play
	// the green keep regions — except a red the playhead STARTED inside.
	const onPlaybackTick = seg.onPlaybackTick;
	useEffect(() => {
		if (!isPlaying) return;
		let raf = 0;
		const tick = () => {
			const el = mediaRef.current;
			if (el) {
				if (el.playbackRate !== speedRef.current) {
					el.playbackRate = speedRef.current;
				}
				// Drop the play-through guard once we've passed the cut we started
				// inside, so later green→red crossings skip normally.
				const pt = playThroughUntilRef.current;
				if (pt != null && el.currentTime >= pt) {
					playThroughUntilRef.current = null;
				}
				if (
					onPlaybackTick(el.currentTime, {
						playThroughUntilSec: playThroughUntilRef.current ?? undefined,
					}) === "stop"
				) {
					el.pause();
				}
				setCurrentTime(el.currentTime);
			}
			raf = requestAnimationFrame(tick);
		};
		raf = requestAnimationFrame(tick);
		return () => cancelAnimationFrame(raf);
	}, [isPlaying, onPlaybackTick]);

	// Persist the Raw Cut working state so an Edit↔Raw Cut round-trip restores
	// it exactly. currentTime is excluded here (it changes ~60fps during
	// playback); it's saved on unmount via the cursor effect below.
	const segExportState = seg.exportState;
	useEffect(() => {
		patchRawCutSession(asset.id, {
			decodeMs,
			params,
			silenceRanges,
			stats,
			acceptedDoubleTakes,
			suggestions,
			aiVerdict,
			outline,
			detectStatus,
			device,
			liveChannel,
			mediaDuration,
			zoom,
			speed: speedState,
			segState: segExportState(),
		});
	}, [
		asset.id,
		decodeMs,
		params,
		silenceRanges,
		stats,
		acceptedDoubleTakes,
		suggestions,
		aiVerdict,
		outline,
		detectStatus,
		device,
		liveChannel,
		mediaDuration,
		zoom,
		speedState,
		segExportState,
	]);

	// Persist the playhead/zoom durably so they survive a mode switch AND a hard
	// reload. A reload doesn't run React unmount cleanup, so we also flush on a
	// 1s interval and on tab-hide / beforeunload. (Kept off the per-change /
	// rAF path so we don't serialize the session 60×/s.)
	const cursorRef = useRef({ currentTime, zoom });
	cursorRef.current = { currentTime, zoom };
	useEffect(() => {
		const flush = () => patchRawCutSession(asset.id, cursorRef.current);
		const id = window.setInterval(flush, 1000);
		window.addEventListener("pagehide", flush);
		window.addEventListener("beforeunload", flush);
		return () => {
			window.clearInterval(id);
			window.removeEventListener("pagehide", flush);
			window.removeEventListener("beforeunload", flush);
			flush();
		};
	}, [asset.id]);

	// Recompute stats from the live segment state, so toggling a clip
	// keep/cut updates the header "after-cut" length immediately.
	useEffect(() => {
		if (!buffer) return;
		setStats((prev) =>
			computeStats({
				buffer,
				ranges: segCutRanges,
				detectMs: prev?.detectMs ?? 0,
			}),
		);
	}, [buffer, segCutRanges]);

	// Preload the model in the background as soon as a clip mounts, so it's
	// hot by the time the user clicks Detect (or auto-detect fires). Only
	// needed for the no-ElevenLabs-key Whisper fallback — with a key the
	// transcription is cloud Scribe and the local model never runs.
	useEffect(() => {
		if (getStoredKey("eleven")) return;
		let cancelled = false;
		(async () => {
			try {
				await transcriptionService.preload({
					modelId: DEFAULT_TRANSCRIPTION_MODEL,
					onProgress: (p) => {
						if (cancelled) return;
						// Only surface preload progress when no other run is active.
						setDetectStatus((cur) =>
							cur.kind === "idle"
								? { kind: "preloading", progress: p.progress }
								: cur,
						);
					},
				});
				if (cancelled) return;
				setDevice(transcriptionService.getActiveDevice());
				setDetectStatus((cur) =>
					cur.kind === "preloading" ? { kind: "idle" } : cur,
				);
			} catch (err) {
				if (cancelled) return;
				// Preload failure is non-fatal — user can still click Detect, which
				// will retry init and surface the real error there.
				console.warn("[raw-cut] model preload failed", err);
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	// RMS envelope of the analysis buffer — snaps applied AI-cut boundaries off
	// audio peaks into the quiet gaps between words (same as Final Pass).
	const rmsEnv = useMemo(
		() => (buffer ? buildRmsEnvelope(buffer) : null),
		[buffer],
	);

	// AI cuts come back in MEDIA seconds (transcript timebase); the segment
	// model seeds from BUFFER-time ranges (the 8k analysis decode drifts
	// slightly shorter). With Scribe word timings, snap the boundaries onto
	// word gaps FIRST (a cut must never clip a word tail), then scale; without
	// words, scale and RMS-snap to the quietest point as before.
	const toBufferRange = useCallback(
		(startMedia: number, endMedia: number): SilenceRange => {
			const bufDur = buffer?.duration ?? 0;
			const medDur = mediaDuration ?? asset.duration ?? bufDur;
			const ratio = bufDur > 0 && medDur > 0 ? bufDur / medDur : 1;
			const words = wordsRef.current;
			if (words && words.length > 0) {
				const snapped = snapCutToWordGaps({
					start: startMedia,
					end: endMedia,
					words,
				});
				if (snapped) {
					// Word gaps are quiet by definition — no RMS snap on top (it could
					// drag a boundary back onto a word).
					return {
						startSec: snapped.start * ratio,
						endSec: snapped.end * ratio,
					};
				}
			}
			const rawStart = startMedia * ratio;
			const rawEnd = endMedia * ratio;
			if (!rmsEnv) return { startSec: rawStart, endSec: rawEnd };
			const startSec = snapToQuietest(rmsEnv, rawStart);
			let endSec = snapToQuietest(rmsEnv, rawEnd);
			// Guard against both boundaries snapping into the same valley.
			if (endSec <= startSec) endSec = rawEnd;
			return { startSec, endSec };
		},
		[buffer, mediaDuration, asset.duration, rmsEnv],
	);

	// The AI content pass: transcript (cloud Scribe over the keep regions, with
	// the free in-browser Whisper as fallback) → Gemini mode:"raw" → cuts.
	// High-confidence mechanical cuts (retake / false-start / filler) apply
	// straight into the segment model; tangent/fluff + low-confidence cuts
	// queue as blue suggestions for Y/N review. Both transcript and analysis
	// are cached by content hash, so re-runs are free until something changes.
	const runAiCut = useCallback(
		async (opts?: { force?: boolean }) => {
			if (!buffer) return;
			if (!getStoredKey("gemini")) {
				setDetectStatus({
					kind: "error",
					message:
						'Add your Gemini API key in "API keys" (Final Pass page) to run the AI cut.',
				});
				return;
			}
			const runId = ++detectRunIdRef.current;
			const t0 = performance.now();
			const modelHfId =
				TRANSCRIPTION_MODELS.find((m) => m.id === DEFAULT_TRANSCRIPTION_MODEL)
					?.huggingFaceId ?? DEFAULT_TRANSCRIPTION_MODEL;

			try {
				// 1) Content hash — the cache key. A stale File handle (post-reload)
				// throws; recover the remembered pointer like Final Pass does.
				let contentHash: string | null = null;
				try {
					contentHash = await computeFileHash(asset.file);
					rememberContentHash(asset.id, contentHash);
				} catch {
					contentHash = recallContentHash(asset.id);
				}
				if (runId !== detectRunIdRef.current) return;

				// 2) Transcript. Cache order: Final Pass's full-clip Scribe → our
				// spliced Scribe → the local-Whisper entry — but with an ElevenLabs
				// key the whisper entry is NEVER reused (tiny collapses back-to-back
				// retakes into one segment and clips word tails; re-transcribing
				// with Scribe beats analyzing a tiny transcript).
				const hasElevenKey = Boolean(getStoredKey("eleven"));
				let segments: TranscriptionSegment[] | null = null;
				let cameFromCache = false;
				wordsRef.current = null;
				if (contentHash) {
					for (const modelId of transcriptCacheModelIds({
						hasElevenKey,
						whisperModelId: modelHfId,
					})) {
						const cached = await readCachedTranscription({
							contentHash,
							modelId,
						});
						if (cached) {
							segments = cached.segments;
							wordsRef.current = cached.words?.length ? cached.words : null;
							cameFromCache = true;
							break;
						}
					}
				}
				if (runId !== detectRunIdRef.current) return;

				if (!segments) {
					// Decode at Whisper/Scribe's expected rate (16k mono), then splice
					// so transcription only sees the green (keep) regions — typically
					// a 60-70% smaller payload on raw footage.
					setDetectStatus({ kind: "decoding" });
					const transcriptionBuf = await decodeMediaAssetForAnalysis({
						asset,
						targetSampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
					});
					if (runId !== detectRunIdRef.current) return;
					if (!transcriptionBuf) {
						setDetectStatus({
							kind: "error",
							message: "No audio to transcribe.",
						});
						return;
					}
					const spliced = spliceKeepRegions({
						samples: transcriptionBuf.getChannelData(0),
						silenceRanges,
						sampleRate: DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
					});
					if (spliced.samples.length === 0) {
						setSuggestions([]);
						setDetectStatus({
							kind: "done",
							durationMs: performance.now() - t0,
							cached: false,
						});
						return;
					}

					if (hasElevenKey) {
						// Cloud Scribe — word-level timestamps, no multi-minute local wait.
						setDetectStatus({ kind: "cloud" });
						const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
						const wav = encodeWav(
							spliced.samples,
							DEFAULT_TRANSCRIPTION_SAMPLE_RATE,
						);
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
							words?: TranscriptWord[];
						};
						if (runId !== detectRunIdRef.current) return;
						segments = remapSegments({
							segments: data.segments,
							keeps: spliced.keeps,
						});
						// Word timings ride the same splice→original remap (same shape).
						const words = Array.isArray(data.words)
							? remapSegments({ segments: data.words, keeps: spliced.keeps })
							: [];
						wordsRef.current = words.length > 0 ? words : null;
						if (contentHash) {
							void writeCachedTranscription({
								cache: {
									version: 1,
									contentHash,
									modelId: RAWCUT_CLOUD_MODEL_ID,
									segments,
									words,
									text: data.text ?? "",
									createdAt: Date.now(),
								},
							});
						}
					} else {
						// Free in-browser Whisper fallback (timestamps are looser —
						// Scribe is the recommended path for accurate boundaries).
						const result = await transcriptionService.transcribe({
							audioData: spliced.samples,
							modelId: DEFAULT_TRANSCRIPTION_MODEL,
							onProgress: (p) => {
								if (runId !== detectRunIdRef.current) return;
								if (p.status === "loading-model") {
									setDetectStatus({
										kind: "loading-model",
										progress: p.progress,
									});
								} else if (p.status === "transcribing") {
									setDetectStatus({
										kind: "transcribing",
										progress: p.progress,
									});
								}
							},
						});
						if (runId !== detectRunIdRef.current) return;
						segments = remapSegments({
							segments: result.segments,
							keeps: spliced.keeps,
						});
						if (contentHash) {
							void writeCachedTranscription({
								cache: {
									version: 1,
									contentHash,
									modelId: modelHfId,
									segments,
									text: result.text,
									createdAt: Date.now(),
								},
							});
						}
						setDevice(transcriptionService.getActiveDevice());
					}
				}

				// 3) Gemini analysis (mode:"raw"). Cached per transcript signature so
				// re-opening the clip never re-bills; force=true (Re-analyze) does.
				// raw2 = chunked engine (windows + retake pass) — never reuse raw1.
				setDetectStatus({ kind: "analyzing" });
				const transcriptHash = `raw2-${hashTranscript(segments)}`;
				let analysis: Analysis | null = null;
				if (!opts?.force && contentHash) {
					analysis = readAnalysisCache({ contentHash, transcriptHash });
				}
				if (!analysis) {
					const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
					const res = await fetch(`${base}/api/final-pass`, {
						method: "POST",
						headers: { "Content-Type": "application/json", ...geminiHeaders() },
						body: JSON.stringify({
							segments,
							rulebook: readRulebook(),
							mode: "raw",
							outline: outline.trim() || undefined,
						}),
					});
					if (!res.ok) {
						const d = (await res.json().catch(() => null)) as {
							error?: string;
						} | null;
						throw new Error(d?.error ?? `AI analysis failed (${res.status})`);
					}
					analysis = (await res.json()) as Analysis;
					if (contentHash) {
						writeAnalysisCache({ contentHash, transcriptHash, analysis });
					}
				}
				if (runId !== detectRunIdRef.current) return;

				// 4) Denoise (swallow stranded one-word keeps), then apply — red or
				// nothing: every cut at/above the confidence floor lands directly in
				// the segment model; below-floor finds are dropped, never queued.
				const denoised = mergeShortKeepIslands({
					cuts: analysis.cuts,
					segments,
				});
				const apply = denoised.filter(shouldApplyCut);
				const dropped = denoised.length - apply.length;
				setAiVerdict({
					score: analysis.score,
					verdict: analysis.verdict,
					reason: analysis.reason,
				});
				setSuggestions([]);
				if (apply.length > 0) {
					setAcceptedDoubleTakes((acc) =>
						mergeRanges([
							...acc,
							...apply.map((c) => toBufferRange(c.start, c.end)),
						]),
					);
				}
				setDetectStatus({
					kind: "done",
					durationMs: performance.now() - t0,
					cached: cameFromCache,
					autoApplied: apply.length,
					dropped,
				});
			} catch (err) {
				if (runId !== detectRunIdRef.current) return;
				setDetectStatus({
					kind: "error",
					message: (err as Error).message,
				});
			}
		},
		[asset, buffer, silenceRanges, outline, toBufferRange],
	);

	const cancelAiCut = useCallback(() => {
		detectRunIdRef.current++;
		transcriptionService.cancel();
		setDetectStatus({ kind: "idle" });
	}, []);

	const acceptSuggestion = useCallback(
		(id: string) => {
			setSuggestions((prev) => {
				const s = prev.find((x) => x.id === id);
				if (!s) return prev;
				setAcceptedDoubleTakes((acc) => [
					...acc,
					toBufferRange(s.startSec, s.endSec),
				]);
				return prev.filter((x) => x.id !== id);
			});
		},
		[toBufferRange],
	);

	const rejectSuggestion = useCallback((id: string) => {
		setSuggestions((prev) => prev.filter((x) => x.id !== id));
	}, []);

	// Accept every remaining suggestion in one go (the "trust the AI" button).
	const acceptAllSuggestions = useCallback(() => {
		setSuggestions((prev) => {
			if (prev.length === 0) return prev;
			setAcceptedDoubleTakes((acc) =>
				mergeRanges([
					...acc,
					...prev.map((s) => toBufferRange(s.startSec, s.endSec)),
				]),
			);
			return [];
		});
	}, [toBufferRange]);

	// Wipe the AI layer — auto-applied AI ranges, queued suggestions, score —
	// back to silence-only cuts. Locks survive; use after a bad AI pass.
	const clearAiCuts = useCallback(() => {
		setAcceptedDoubleTakes([]);
		setSuggestions([]);
		setAiVerdict(null);
		setDetectStatus({ kind: "idle" });
		toast.success("Cleared AI cuts — back to silence-only.");
	}, []);

	// Import a cut list from an external editor (e.g. a Claude Code agent that
	// read the transcript and produced its own edit). REPLACE semantics: the
	// imported list IS the cut list — the previous AI layer (a Gemini pass or
	// an earlier import) is wiped first so two editors' opinions never stack.
	const importCuts = useCallback(
		async (file: File) => {
			try {
				const cuts = parseImportedCuts(await file.text());
				if (cuts.length === 0) {
					toast.error("No usable cuts in that file.");
					return;
				}
				// Red-or-nothing: the sender already decided — apply the whole list.
				setAcceptedDoubleTakes(
					mergeRanges(cuts.map((c) => toBufferRange(c.start, c.end))),
				);
				setSuggestions([]);
				setAiVerdict(null);
				toast.success(
					`Imported ${cuts.length} cuts — all applied (previous AI cuts replaced).`,
				);
			} catch (err) {
				toast.error(`Import failed: ${(err as Error).message}`);
			}
		},
		[toBufferRange],
	);

	// --- Live cut channel (Claude Code ↔ this session) -----------------------
	// The agent pushes commands in MEDIA seconds; set/add boundaries go through
	// toBufferRange (word-snapped), adjust/remove are EXACT ("make it 15s" means
	// 15s) — plain ratio scaling, no snapping.
	const bufMediaRatio = useCallback(() => {
		const bufDur = buffer?.duration ?? 0;
		const medDur = mediaDuration ?? asset.duration ?? bufDur;
		return bufDur > 0 && medDur > 0 ? bufDur / medDur : 1;
	}, [buffer, mediaDuration, asset.duration]);

	const applyLive = useCallback(
		(cmd: LiveCommand) => {
			if (cmd.action === "run-ai-cut") {
				toast.message("Live: agent started an AI cut run.");
				void runAiCut(cmd.force ? { force: true } : undefined);
				return;
			}
			if (cmd.action === "clear") {
				setAcceptedDoubleTakes([]);
				setSuggestions([]);
				setAiVerdict(null);
				toast.message("Live: cleared AI cuts.");
				return;
			}
			if (cmd.action === "set" || cmd.action === "add") {
				setAcceptedDoubleTakes((acc) => {
					const incoming = cmd.cuts.map((c) => toBufferRange(c.start, c.end));
					return mergeRanges(
						cmd.action === "set" ? incoming : [...acc, ...incoming],
					);
				});
				if (cmd.action === "set") {
					setSuggestions([]);
					setAiVerdict(null);
				}
				toast.success(
					`Live: ${cmd.action === "set" ? "applied" : "added"} ${cmd.cuts.length} cut${cmd.cuts.length === 1 ? "" : "s"}.`,
				);
				return;
			}
			const ratio = bufMediaRatio();
			setAcceptedDoubleTakes((acc) => {
				const media = acc.map((r) => ({
					start: r.startSec / ratio,
					end: r.endSec / ratio,
				}));
				const next = applyLiveCommand(media, cmd);
				return next.map((s) => ({
					startSec: s.start * ratio,
					endSec: s.end * ratio,
				}));
			});
			toast.success(
				cmd.action === "adjust"
					? `Live: cut at ${formatSec(cmd.at)} is now ${formatSec(cmd.start)}–${formatSec(cmd.end)}.`
					: `Live: removed the cut at ${formatSec(cmd.at)}.`,
			);
		},
		[toBufferRange, bufMediaRatio, runAiCut],
	);

	// Current applied AI ranges + detect status, readable from the poll loop
	// without re-binding it.
	const appliedRef = useRef(acceptedDoubleTakes);
	appliedRef.current = acceptedDoubleTakes;
	const detectStatusRef = useRef(detectStatus);
	detectStatusRef.current = detectStatus;
	const applyLiveRef = useRef(applyLive);
	applyLiveRef.current = applyLive;

	useEffect(() => {
		if (!liveChannel) return;
		let cancelled = false;
		let cursor = 0;
		const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
		const url = `${base}/api/final-pass/live-cuts`;
		const tick = async () => {
			try {
				const res = await fetch(
					`${url}?channel=${encodeURIComponent(liveChannel)}&after=${cursor}`,
				);
				if (!res.ok || cancelled) return;
				const data = (await res.json()) as {
					commands: Array<{ seq: number; cmd: unknown }>;
					latest: number;
				};
				if (cancelled) return;
				// A redeploy wipes the channel store; clamp so new pushes aren't missed.
				if (data.latest < cursor) cursor = data.latest;
				for (const { seq, cmd } of data.commands) {
					cursor = Math.max(cursor, seq);
					const parsed = parseLiveCommand(cmd);
					if (parsed) applyLiveRef.current(parsed);
				}
				// Report state back so the agent can read what's on the timeline.
				const ratio = bufMediaRatio();
				await fetch(url, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						channel: liveChannel,
						state: {
							asset: asset.name,
							durationSec: mediaDuration ?? asset.duration ?? null,
							// Lets the agent poll for "done" after pushing run-ai-cut.
							detect: detectStatusRef.current.kind,
							cuts: appliedRef.current.map((r) => ({
								start: r.startSec / ratio,
								end: r.endSec / ratio,
							})),
							updatedAt: Date.now(),
						},
					}),
				});
			} catch {
				/* offline tick — retry on the next interval */
			}
		};
		const id = window.setInterval(tick, 1500);
		void tick();
		return () => {
			cancelled = true;
			window.clearInterval(id);
		};
	}, [liveChannel, asset.name, asset.duration, mediaDuration, bufMediaRatio]);

	const toggleLive = useCallback(() => {
		setLiveChannel((cur) => {
			if (cur) {
				toast.message("Live link closed.");
				return null;
			}
			const code = `RC-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
			toast.success(
				`Live link open — channel ${code}. Give this code to your agent.`,
			);
			return code;
		});
	}, []);

	// Y / N act on the blue suggestion under the playhead, else the next one.
	const pickBlue = useCallback(() => {
		if (suggestions.length === 0) return null;
		const t = currentTime;
		const containing = suggestions.find(
			(s) => t >= s.startSec && t <= s.endSec,
		);
		if (containing) return containing;
		const after = [...suggestions]
			.sort((a, b) => a.startSec - b.startSec)
			.find((s) => s.startSec >= t);
		return after ?? suggestions[0];
	}, [suggestions, currentTime]);
	// Rapid review: after Y/N on a suggestion, hop the playhead to just before
	// the next one so Andy rides through the queue without touching the timeline.
	const advanceToNextBlue = useCallback(
		(actedOn: AiCutSuggestion) => {
			const next = suggestions
				.filter((x) => x.id !== actedOn.id && x.startSec > actedOn.startSec)
				.sort((a, b) => a.startSec - b.startSec)[0];
			if (next) handleSeek(Math.max(0, next.startSec - 1.2));
		},
		[suggestions, handleSeek],
	);
	const acceptBlue = useCallback(() => {
		const s = pickBlue();
		if (!s) return;
		acceptSuggestion(s.id);
		advanceToNextBlue(s);
	}, [pickBlue, acceptSuggestion, advanceToNextBlue]);
	const rejectBlue = useCallback(() => {
		const s = pickBlue();
		if (!s) return;
		rejectSuggestion(s.id);
		advanceToNextBlue(s);
	}, [pickBlue, rejectSuggestion, advanceToNextBlue]);

	// Cmd/Ctrl+S — download the keep/cut/lock/mark state as JSON.
	const saveCuts = useCallback(() => {
		const data = {
			version: 1,
			asset: asset.name,
			durationSec: mediaDuration ?? asset.duration ?? null,
			segments: seg.segments,
		};
		const blob = new Blob([JSON.stringify(data, null, 2)], {
			type: "application/json",
		});
		const url = URL.createObjectURL(blob);
		const a = document.createElement("a");
		a.href = url;
		a.download = `${asset.name.replace(/\.[^.]+$/, "")}-rawcut.json`;
		a.click();
		URL.revokeObjectURL(url);
	}, [asset.name, mediaDuration, asset.duration, seg.segments]);

	// Step 5 — drop the kept clips onto the timeline (silences rippled out, cut
	// footage recoverable via clip trims) and flip to Edit mode to fine-tune /
	// export. Non-destructive; idempotent (replaces a prior "Raw Cut" track).
	const sendToEdit = useCallback(() => {
		if (!buffer) return;
		try {
			const result = sendRawCutToTimeline({
				editor,
				mediaId: asset.id,
				mediaName: asset.name,
				segments: seg.segments,
				bufferDuration: buffer.duration,
				mediaDuration: mediaDuration ?? asset.duration ?? buffer.duration,
			});
			if (result.keptClips === 0) {
				toast.error("Nothing to send — every clip is cut.");
				return;
			}
			toast.success(
				`Sent ${result.keptClips} clip${
					result.keptClips === 1 ? "" : "s"
				} (${formatSec(result.keptSec)}) to the timeline.`,
			);
			setMode("edit");
		} catch (err) {
			toast.error(`Send to Edit failed: ${(err as Error).message}`);
		}
	}, [
		buffer,
		editor,
		asset.id,
		asset.name,
		asset.duration,
		seg.segments,
		mediaDuration,
		setMode,
	]);

	// Wipe the Raw Cut tracks from the timeline (keeps the source clip + this
	// Raw Cut session). Safe to run from Raw Cut mode while the heavy Edit
	// timeline is unmounted.
	const removeFromEdit = useCallback(() => {
		const removed = removeRawCutFromTimeline(editor);
		toast[removed ? "success" : "message"](
			removed
				? "Removed the Raw Cut tracks from the timeline."
				: "No Raw Cut tracks on the timeline.",
		);
	}, [editor]);

	// Full Raw Cut keymap — playback + zoom + cut-status + navigation.
	useRawCutKeybindings({
		playPause: togglePlay,
		zoomIn,
		zoomOut,
		setSpeed,
		speedUp,
		pause: pausePlayback,
		stepFrames,
		jumpSeconds,
		toggleCurrent: seg.toggleCurrent,
		togglePrev: seg.togglePrev,
		toggleNext: seg.toggleNext,
		togglePrevGreen: seg.togglePrevGreen,
		toggleNextGreen: seg.toggleNextGreen,
		cycleAndAdvance: seg.cycleAndAdvance,
		sweepForward: seg.sweepForward,
		toggleLock: seg.toggleLock,
		toggleMark: seg.toggleMark,
		split: seg.splitHere,
		unwind: seg.unwind,
		nextGreen: seg.gotoNextGreen,
		prevGreen: seg.gotoPrevGreen,
		nextBoundary: seg.gotoNextBoundary,
		prevBoundary: seg.gotoPrevBoundary,
		acceptBlue,
		rejectBlue,
		undo: seg.undo,
		save: saveCuts,
	});

	return (
		<div className="flex h-full w-full flex-col">
			<div className="flex shrink-0 items-center justify-between border-b px-4 py-2">
				<div className="flex items-baseline gap-4 text-sm">
					<div>
						<span className="text-muted-foreground">Loaded:</span>{" "}
						<span className="text-foreground font-medium">{asset.name}</span>
					</div>
					{stats ? (
						<div className="flex items-baseline gap-2">
							<span className="text-muted-foreground text-xs line-through">
								{formatSec(buffer?.duration ?? asset.duration ?? 0)}
							</span>
							<span className="text-muted-foreground text-xs">→</span>
							<span className="text-green-500 text-lg font-semibold tabular-nums">
								{formatSec(stats.keepDurationSec)}
							</span>
							<span className="text-muted-foreground text-xs">
								after cut · {stats.silenceCount} silences removed
							</span>
							{aiVerdict && (
								<span
									className={cn(
										"rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums",
										aiVerdict.score >= 7
											? "bg-green-500/20 text-green-500"
											: "bg-yellow-500/20 text-yellow-500",
									)}
									title={aiVerdict.reason}
								>
									AI {aiVerdict.score.toFixed(1)}/10
								</span>
							)}
						</div>
					) : (
						<span className="text-muted-foreground text-xs">
							{formatDuration(asset.duration)}
						</span>
					)}
				</div>
				<div className="flex items-center gap-2">
					<Button variant="ghost" size="sm" onClick={onChange}>
						Change clip
					</Button>
					<Button
						variant="outline"
						size="sm"
						onClick={removeFromEdit}
						title="Remove the Raw Cut tracks from the timeline (keeps your clip + cuts)"
					>
						Remove from timeline
					</Button>
					<Button
						size="sm"
						onClick={sendToEdit}
						disabled={!buffer}
						title="Drop the kept clips onto the timeline and switch to Edit"
					>
						Send to Edit
					</Button>
				</div>
			</div>

			<div className="flex min-h-0 flex-1 flex-col gap-3 px-6 py-4">
				<div className="flex min-h-0 flex-1 items-center justify-center">
					{asset.type === "video" && asset.url ? (
						// biome-ignore lint/a11y/useMediaCaption: raw-cut preview, captions live downstream
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
								if (pendingSeekRef.current > 0) {
									el.currentTime = pendingSeekRef.current;
									pendingSeekRef.current = 0;
								}
							}}
							onPlay={(e) => {
								const el = e.target as HTMLVideoElement;
								setIsPlaying(true);
								el.playbackRate = speedRef.current;
								// Start inside a red clip → play THROUGH it (audit the cut).
								capturePlayThrough(el.currentTime);
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
								if (pendingSeekRef.current > 0) {
									el.currentTime = pendingSeekRef.current;
									pendingSeekRef.current = 0;
								}
							}}
							onPlay={(e) => {
								const el = e.target as HTMLAudioElement;
								setIsPlaying(true);
								el.playbackRate = speedRef.current;
								// Start inside a red clip → play THROUGH it (audit the cut).
								capturePlayThrough(el.currentTime);
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

				<DetectionKnobs
					params={params}
					onChange={setParams}
					onUpdate={runDetect}
					running={detecting}
				/>

				<TranscriptionPanel
					status={detectStatus}
					device={device}
					onRun={() => void runAiCut()}
					onReanalyze={() => void runAiCut({ force: true })}
					onCancel={cancelAiCut}
					suggestions={suggestions}
					verdict={aiVerdict}
					outline={outline}
					onOutlineChange={setOutline}
					onAccept={acceptSuggestion}
					onReject={rejectSuggestion}
					onAcceptAll={acceptAllSuggestions}
					onImport={importCuts}
					onClearAi={clearAiCuts}
					onSeek={handleSeek}
					liveChannel={liveChannel}
					onLiveToggle={toggleLive}
				/>

				<div className="text-muted-foreground flex items-center gap-4 text-xs">
					{decoding && (
						<span>Decoding audio… {Math.round(decodeProgress * 100)}%</span>
					)}
					{!decoding && decodeMs != null && (
						<span>Decoded in {formatMs(decodeMs)}</span>
					)}
					{stats && <span>Detected in {formatMs(stats.detectMs)}</span>}
					{decodeErr && <span className="text-destructive">⚠ {decodeErr}</span>}
				</div>

				<div className="flex shrink-0 items-center justify-between">
					<div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
						{seg.current && (
							<span
								className={cn(
									"rounded px-1.5 py-0.5 font-medium tabular-nums",
									seg.current.status === "keep"
										? "bg-green-500/20 text-green-500"
										: "bg-red-500/20 text-red-400",
								)}
							>
								clip {seg.currentIndex + 1}/{seg.segments.length} ·{" "}
								{seg.current.status === "keep" ? "KEEP" : "CUT"}
								{seg.current.locked ? " · 🔒" : ""}
								{seg.current.marked ? " · ●" : ""}
							</span>
						)}
						<kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono">
							Q/W/E
						</kbd>
						<span>toggle prev/cur/next</span>
						<span className="opacity-50">·</span>
						<kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono">
							O
						</kbd>
						<span>cut+next</span>
						<span className="opacity-50">·</span>
						<kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono">
							H
						</kbd>
						<span>lock</span>
						<span className="opacity-50">·</span>
						<kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono">
							⇧←/→
						</kbd>
						<span>green</span>
						<span className="opacity-50">·</span>
						<kbd className="bg-muted rounded border px-1.5 py-0.5 font-mono">
							1/2/3
						</kbd>
						<span>speed</span>
						{speedState !== 1 && (
							<span className="ml-1 rounded bg-yellow-500/20 px-1.5 py-0.5 font-medium text-yellow-500 tabular-nums">
								{speedState}×
							</span>
						)}
					</div>
					<div className="flex items-center gap-1">
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

				<div className="h-36 shrink-0">
					{buffer ? (
						<RawCutWaveform
							buffer={buffer}
							silenceRanges={segCutRanges}
							blueRanges={suggestions.map((s) => ({
								startSec: s.startSec,
								endSec: s.endSec,
							}))}
							markers={seg.markers}
							activeRange={
								seg.current
									? {
											startSec: seg.current.startSec,
											endSec: seg.current.endSec,
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
						<div className="bg-muted/30 text-muted-foreground flex h-full items-center justify-center rounded border border-dashed text-xs">
							{decoding
								? `Decoding ${Math.round(decodeProgress * 100)}%…`
								: (decodeErr ?? "Waveform pending…")}
						</div>
					)}
				</div>
			</div>
		</div>
	);
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

// A restored session may carry an in-progress detect status whose run died
// with the unmount. Coerce those back to idle; finished/error states persist
// as-is (the suggestions themselves are restored separately).
function restoreDetectStatus(status: DetectStatus | undefined): DetectStatus {
	if (!status) return { kind: "idle" };
	switch (status.kind) {
		case "preloading":
		case "loading-model":
		case "decoding":
		case "cloud":
		case "transcribing":
		case "analyzing":
			return { kind: "idle" };
		default:
			return status;
	}
}

function computeStats({
	buffer,
	ranges,
	detectMs,
}: {
	buffer: AudioBuffer;
	ranges: SilenceRange[];
	detectMs: number;
}): DetectionStats {
	let silenceDurationSec = 0;
	for (const r of ranges) silenceDurationSec += r.endSec - r.startSec;
	return {
		silenceCount: ranges.length,
		silenceDurationSec,
		keepDurationSec: Math.max(0, buffer.duration - silenceDurationSec),
		detectMs,
	};
}

function mergeRanges(ranges: SilenceRange[]): SilenceRange[] {
	if (ranges.length === 0) return [];
	const sorted = [...ranges].sort((a, b) => a.startSec - b.startSec);
	const out: SilenceRange[] = [{ ...sorted[0] }];
	for (let i = 1; i < sorted.length; i++) {
		const last = out[out.length - 1];
		const cur = sorted[i];
		if (cur.startSec <= last.endSec) {
			last.endSec = Math.max(last.endSec, cur.endSec);
		} else {
			out.push({ ...cur });
		}
	}
	return out;
}

function formatDuration(d?: number) {
	if (!d || !Number.isFinite(d)) return "—";
	const m = Math.floor(d / 60);
	const s = Math.floor(d % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

function formatSec(s: number) {
	if (!Number.isFinite(s)) return "—";
	if (s < 60) return `${s.toFixed(1)}s`;
	const m = Math.floor(s / 60);
	const sec = Math.floor(s % 60);
	return `${m}m${String(sec).padStart(2, "0")}s`;
}

function formatMs(ms: number) {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}
