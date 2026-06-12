// Denoise the AI's cut list before it becomes segments. Gemini occasionally
// strands a tiny KEEP (green) "island" between two cuts — often a single word
// with no real reason to survive (Andy sees it ~twice/video). Left alone it
// shows as a one-word green blip in the transcript/waveform and makes skip-cuts
// playback stutter. This swallows those islands into the surrounding cut.
//
// Operates on detection output only (the AI cuts), so it runs on a FRESH
// analysis — before any manual locks exist — and never overrides Andy's hand
// edits. Pure function; unit-tested in __tests__/final-pass-denoise.test.ts.

interface TimedText {
	start: number;
	end: number;
	text: string;
}

// Default thresholds: a keep gap under 0.4s, OR holding ≤2 words, is noise.
const DEFAULT_MIN_KEEP_SEC = 0.4;
const DEFAULT_MAX_KEEP_WORDS = 2;

function wordsInRange(
	segments: TimedText[],
	startSec: number,
	endSec: number,
): number {
	let count = 0;
	for (const s of segments) {
		if (s.start < endSec && s.end > startSec) {
			count += s.text.trim().split(/\s+/).filter(Boolean).length;
		}
	}
	return count;
}

/**
 * Merge "green islands" — KEEP gaps strictly BETWEEN two cuts that are too short
 * (< `minKeepSec`) or too sparse (≤ `maxKeepWords` words) to be real kept clips —
 * into one spanning cut. Leading/trailing keeps (before the first / after the
 * last cut) are never touched. Greedy: a run of adjacent tiny islands collapses
 * into a single cut. The merged cut inherits the FIRST cut's reason/kind.
 */
export function mergeShortKeepIslands<
	T extends { start: number; end: number },
>({
	cuts,
	segments,
	minKeepSec = DEFAULT_MIN_KEEP_SEC,
	maxKeepWords = DEFAULT_MAX_KEEP_WORDS,
}: {
	cuts: T[];
	segments: TimedText[];
	minKeepSec?: number;
	maxKeepWords?: number;
}): T[] {
	if (cuts.length <= 1) return cuts.slice();
	const sorted = cuts.slice().sort((a, b) => a.start - b.start);
	const out: T[] = [{ ...sorted[0] }];
	for (let i = 1; i < sorted.length; i++) {
		const prev = out[out.length - 1];
		const cur = sorted[i];
		const gap = cur.start - prev.end;
		const tiny =
			gap < minKeepSec ||
			wordsInRange(segments, prev.end, cur.start) <= maxKeepWords;
		if (tiny) {
			// Swallow the island: extend the previous cut to cover this one.
			prev.end = Math.max(prev.end, cur.end);
		} else {
			out.push({ ...cur });
		}
	}
	return out;
}
