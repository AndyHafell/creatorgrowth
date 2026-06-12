import type {
	BeatCandidate,
	MagicPlan,
	MagicPlanClip,
	TimelineWord,
} from "./types";

// v2 shot list: continuous camera direction instead of v1's sparse beats.
// Every second of the scope window gets an active camera state — Magic
// Reframe is the resting state between beats, Magic Zoom punches on strong
// triggers, Magic Highlighter on text moments. Clips are back-to-back and
// never overlap (overlapping camera clips are confusing to review). Pure —
// all times are timeline seconds, no opencut-wasm imports, bun-testable.

const RESTING_REASON = "Resting frame";

export interface ShotListOptions {
	beats: BeatCandidate[];
	/** Natural cut points (silence gaps, sentence ends) — timeline seconds. */
	boundaries?: number[];
	scopeStart: number;
	scopeEnd: number;
	zoomClipSec?: number;
	highlightClipSec?: number;
	/** Minimum length for ANY clip, reframes included. */
	minClipSec?: number;
	/** Reframes longer than this get split (at a boundary when one fits). */
	maxReframeSec?: number;
	leadInSec?: number;
	clusterSec?: number;
	/** Heuristic resting zoom — the vision director overrides per segment. */
	restingScale?: number;
}

function reframeClip({
	start,
	end,
	restingScale,
}: {
	start: number;
	end: number;
	restingScale: number;
}): MagicPlanClip {
	return {
		kind: "reframe",
		start,
		end,
		scale: restingScale,
		focalX: 50,
		focalY: 50,
		easeIn: 0,
		easeOut: 0,
		reason: RESTING_REASON,
	};
}

/** Split [from, to] into reframe pieces, cutting at boundaries when possible. */
function reframeSegments({
	from,
	to,
	boundaries,
	minClipSec,
	maxReframeSec,
	restingScale,
}: {
	from: number;
	to: number;
	boundaries: number[];
	minClipSec: number;
	maxReframeSec: number;
	restingScale: number;
}): MagicPlanClip[] {
	const out: MagicPlanClip[] = [];
	let cursor = from;
	while (to - cursor > maxReframeSec) {
		// The cut must leave both sides at least minClipSec long.
		const limit = Math.max(
			cursor + minClipSec,
			Math.min(cursor + maxReframeSec, to - minClipSec),
		);
		const atBoundary = boundaries
			.filter((t) => t > cursor + minClipSec && t <= limit)
			.pop();
		const cut = atBoundary ?? limit;
		out.push(reframeClip({ start: cursor, end: cut, restingScale }));
		cursor = cut;
	}
	out.push(reframeClip({ start: cursor, end: to, restingScale }));
	return out;
}

/**
 * Beats + gaps → a contiguous shot list covering [scopeStart, scopeEnd].
 * Beat clips keep their v1 shape (lead-in, kind-specific length); everything
 * between them becomes reframe clips. Gaps too short for a reframe are
 * bridged by stretching the neighboring clip.
 */
export function buildShotList({
	beats,
	boundaries = [],
	scopeStart,
	scopeEnd,
	zoomClipSec = 5,
	highlightClipSec = 4,
	minClipSec = 2,
	maxReframeSec = 10,
	leadInSec = 0.35,
	clusterSec = 3,
	restingScale = 1.3,
}: ShotListOptions): MagicPlan {
	if (scopeEnd <= scopeStart) return { clips: [] };

	// 1. Beats inside the scope, clustered to the strongest per window.
	const inScope = beats
		.filter((b) => b.triggerStart >= scopeStart && b.triggerStart < scopeEnd)
		.sort((a, b) => a.triggerStart - b.triggerStart);
	const picked: BeatCandidate[] = [];
	for (const cand of inScope) {
		const last = picked[picked.length - 1];
		if (last && cand.triggerStart - last.triggerStart < clusterSec) {
			if (cand.strength > last.strength) picked[picked.length - 1] = cand;
			continue;
		}
		picked.push(cand);
	}

	// 2. Beat clips, clamped to scope, collisions resolved by truncating the
	//    earlier clip when it stays a sane length (else the later beat drops).
	const beatClips: MagicPlanClip[] = [];
	for (const cand of picked) {
		const clipLen = cand.kind === "zoom" ? zoomClipSec : highlightClipSec;
		const start = Math.max(scopeStart, cand.triggerStart - leadInSec);
		const end = Math.min(scopeEnd, start + clipLen);
		if (end - start < minClipSec) continue;
		const focalX = cand.focalHint?.x ?? 50;
		const focalY = cand.focalHint?.y ?? 50;
		const clip: MagicPlanClip = {
			kind: cand.kind,
			start,
			end,
			scale: cand.kind === "zoom" ? 1.8 : 1,
			focalX,
			focalY,
			...(cand.kind === "highlight"
				? {
						region: {
							x: Math.max(0, Math.min(60, focalX - 20)),
							y: Math.max(0, Math.min(60, focalY - 15)),
							w: 40,
							h: 30,
						},
					}
				: {}),
			easeIn: 0.5,
			easeOut: 0.5,
			reason: cand.reason,
		};
		const prev = beatClips[beatClips.length - 1];
		if (prev && clip.start < prev.end) {
			if (clip.start - prev.start >= minClipSec) {
				prev.end = clip.start;
			} else {
				continue;
			}
		}
		beatClips.push(clip);
	}

	// 3. Fill every gap with reframes; bridge gaps too short to host one.
	const clips: MagicPlanClip[] = [];
	let cursor = scopeStart;
	for (const beatClip of beatClips) {
		const gap = beatClip.start - cursor;
		if (gap > 0) {
			if (gap < minClipSec) {
				beatClip.start = cursor;
			} else {
				clips.push(
					...reframeSegments({
						from: cursor,
						to: beatClip.start,
						boundaries,
						minClipSec,
						maxReframeSec,
						restingScale,
					}),
				);
			}
		}
		clips.push(beatClip);
		cursor = beatClip.end;
	}
	const tail = scopeEnd - cursor;
	if (tail > 0) {
		if (tail < minClipSec && clips.length > 0) {
			clips[clips.length - 1].end = scopeEnd;
		} else {
			clips.push(
				...reframeSegments({
					from: cursor,
					to: scopeEnd,
					boundaries,
					minClipSec,
					maxReframeSec,
					restingScale,
				}),
			);
		}
	}

	return { clips };
}

/**
 * Defensive pass over a director/heuristic shot list before insertion:
 * sorted, clamped to scope, overlaps trimmed to contiguity, slivers dropped.
 * Gaps are left alone — the director was asked for full coverage; a gap it
 * insisted on is a deliberate "no effect here".
 */
export function sanitizeShotList({
	clips,
	scopeStart,
	scopeEnd,
	minClipSec = 1,
}: {
	clips: MagicPlanClip[];
	scopeStart: number;
	scopeEnd: number;
	minClipSec?: number;
}): MagicPlanClip[] {
	const sorted = [...clips]
		.sort((a, b) => a.start - b.start)
		.map((c) => ({ ...c }));
	const out: MagicPlanClip[] = [];
	for (const clip of sorted) {
		clip.start = Math.max(clip.start, scopeStart);
		clip.end = Math.min(clip.end, scopeEnd);
		const prev = out[out.length - 1];
		if (prev && clip.start < prev.end) clip.start = prev.end;
		if (clip.end - clip.start >= minClipSec) out.push(clip);
	}
	return out;
}

/**
 * Frame sample times for the vision director: a fixed grid across the scope
 * (centered in each step), widening the step instead of exceeding maxFrames.
 */
export function directorFrameTimes({
	scopeStart,
	scopeEnd,
	stepSec = 4.5,
	maxFrames,
}: {
	scopeStart: number;
	scopeEnd: number;
	stepSec?: number;
	maxFrames: number;
}): number[] {
	const span = scopeEnd - scopeStart;
	if (span <= 0 || maxFrames <= 0) return [];
	const step = Math.max(stepSec, span / maxFrames);
	const out: number[] = [];
	for (let t = scopeStart + step / 2; t < scopeEnd; t += step) {
		out.push(t);
	}
	return out.slice(0, maxFrames);
}

/**
 * Timestamped transcript lines for the director prompt — words grouped into
 * sentences (breaking on terminal punctuation, long spans, or word count),
 * each line prefixed "[start–end]".
 */
export function wordsToTranscriptLines({
	words,
	scopeStart,
	scopeEnd,
	maxLineSec = 8,
	maxLineWords = 20,
}: {
	words: TimelineWord[];
	scopeStart: number;
	scopeEnd: number;
	maxLineSec?: number;
	maxLineWords?: number;
}): string[] {
	const scoped = words.filter(
		(w) => w.start >= scopeStart && w.start < scopeEnd,
	);
	const lines: string[] = [];
	let buf: TimelineWord[] = [];
	const flush = () => {
		if (buf.length === 0) return;
		const text = buf.map((w) => w.text).join(" ");
		lines.push(
			`[${buf[0].start.toFixed(1)}–${buf[buf.length - 1].end.toFixed(1)}] ${text}`,
		);
		buf = [];
	};
	for (const word of scoped) {
		buf.push(word);
		if (
			/[.?!]["')\]]?$/.test(word.text) ||
			word.end - buf[0].start >= maxLineSec ||
			buf.length >= maxLineWords
		) {
			flush();
		}
	}
	flush();
	return lines;
}
