// Word-boundary snapping for AI cut ranges. Scribe gives word-level timestamps;
// a cut boundary placed mid-word clips a syllable (the whisper-era bug class:
// green region ends before the final syllable). Instead of trusting the model's
// fuzzy seconds, snap each boundary into the silent GAP between the last kept
// word and the first cut word (and vice versa at the end). Pure function;
// unit-tested in __tests__/word-snap.test.ts.

export interface TranscriptWord {
	text: string;
	start: number;
	end: number;
}

/**
 * Snap a cut [start, end] (media seconds) onto word-gap boundaries:
 *  - a word is CUT when the majority of its duration falls inside the range;
 *  - the snapped start sits in the gap between the previous kept word and the
 *    first cut word (midpoint), never before the kept word's tail;
 *  - the snapped end sits in the gap between the last cut word and the next
 *    kept word (midpoint), never past the kept word's head.
 * Returns null when no word is cut (pure silence/noise — let the RMS snap
 * handle it) or the snapped range would be degenerate.
 */
export function snapCutToWordGaps({
	start,
	end,
	words,
}: {
	start: number;
	end: number;
	words: TranscriptWord[];
}): { start: number; end: number } | null {
	if (words.length === 0 || end <= start) return null;
	const sorted = [...words].sort((a, b) => a.start - b.start);

	// A contiguous run of words has its majority inside the cut (a word between
	// two cut words is fully covered, so the run can't have holes).
	let firstIdx = -1;
	let lastIdx = -1;
	for (let i = 0; i < sorted.length; i++) {
		const w = sorted[i];
		const dur = w.end - w.start;
		const overlap = Math.min(end, w.end) - Math.max(start, w.start);
		const isCut =
			dur > 0 ? overlap > dur / 2 : w.start >= start && w.start <= end;
		if (isCut) {
			if (firstIdx === -1) firstIdx = i;
			lastIdx = i;
		}
	}
	if (firstIdx === -1) return null;

	const first = sorted[firstIdx];
	const last = sorted[lastIdx];
	const prev = firstIdx > 0 ? sorted[firstIdx - 1] : null;
	const next = lastIdx < sorted.length - 1 ? sorted[lastIdx + 1] : null;

	// clamp(mid, lo, hi) with lo winning on degenerate (overlapping-word) gaps —
	// protecting the KEPT word is the priority on both sides.
	let snappedStart: number;
	if (prev) {
		const mid = (prev.end + first.start) / 2;
		snappedStart = Math.max(prev.end, Math.min(mid, first.start));
	} else {
		snappedStart = Math.min(start, first.start);
	}
	let snappedEnd: number;
	if (next) {
		const mid = (last.end + next.start) / 2;
		snappedEnd = Math.min(next.start, Math.max(mid, last.end));
	} else {
		snappedEnd = Math.max(end, last.end);
	}

	if (snappedEnd <= snappedStart) return null;
	return { start: snappedStart, end: snappedEnd };
}
