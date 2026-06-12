import { describe, expect, it } from "bun:test";
import { snapCutToWordGaps } from "../word-snap";

// Word builder. Scribe word timings in media seconds.
const W = (text: string, start: number, end: number) => ({ text, start, end });

// "keep one KEEP two three CUT cut-words CUT four keep" layout:
//   kept:  one [0.0-0.4]   two [0.5-0.9]
//   cut:   bad [1.1-1.5]   take [1.6-2.0]
//   kept:  four [2.4-2.8]
const words = () => [
	W("one", 0.0, 0.4),
	W("two", 0.5, 0.9),
	W("bad", 1.1, 1.5),
	W("take", 1.6, 2.0),
	W("four", 2.4, 2.8),
];

describe("snapCutToWordGaps", () => {
	it("snaps both boundaries into the word gaps around the cut words", () => {
		// Model cut lands loosely on the two middle words.
		const snapped = snapCutToWordGaps({ start: 1.2, end: 1.9, words: words() });
		// Start: midpoint of the gap [0.9, 1.1] = 1.0; end: midpoint of [2.0, 2.4] = 2.2.
		expect(snapped).toEqual({ start: 1.0, end: 2.2 });
	});

	it("never clips the tail of the kept word before the cut", () => {
		// Cut start lands INSIDE "two" (0.5-0.9) but covers <half of it → "two" is
		// kept, and the snapped start must not start before its tail ends.
		const snapped = snapCutToWordGaps({ start: 0.8, end: 1.9, words: words() });
		expect(snapped).not.toBeNull();
		expect((snapped as { start: number }).start).toBeGreaterThanOrEqual(0.9);
	});

	it("never clips the head of the kept word after the cut", () => {
		// Cut end lands inside "four" (2.4-2.8) but covers <half → "four" is kept.
		const snapped = snapCutToWordGaps({ start: 1.1, end: 2.5, words: words() });
		expect(snapped).not.toBeNull();
		expect((snapped as { end: number }).end).toBeLessThanOrEqual(2.4);
	});

	it("treats a word with its majority inside the cut as a cut word", () => {
		// Cut covers most of "bad" (1.1-1.5) → it must fall inside the cut span.
		const snapped = snapCutToWordGaps({
			start: 1.15,
			end: 2.2,
			words: words(),
		});
		expect(snapped).not.toBeNull();
		expect((snapped as { start: number }).start).toBeLessThanOrEqual(1.1);
	});

	it("returns null when no words overlap the cut (caller falls back to RMS)", () => {
		expect(
			snapCutToWordGaps({ start: 5.0, end: 6.0, words: words() }),
		).toBeNull();
		expect(snapCutToWordGaps({ start: 1.0, end: 2.0, words: [] })).toBeNull();
	});

	it("keeps the original start when the first cut word is the first word", () => {
		// Cut from before any speech: nothing kept before it to protect.
		const snapped = snapCutToWordGaps({ start: 0.0, end: 1.0, words: words() });
		expect(snapped).toEqual({ start: 0.0, end: 1.0 });
	});

	it("extends the end past the last cut word when the cut ends the file", () => {
		const snapped = snapCutToWordGaps({ start: 2.3, end: 3.5, words: words() });
		// "four" is the last word; no next word to protect → keep the model's end.
		expect(snapped).toEqual({ start: 2.2, end: 3.5 });
	});

	it("prefers the kept word tail when word timings overlap (degenerate gap)", () => {
		// prev.end (1.0) > firstCut.start (0.95): impossible gap → start = prev.end.
		const overlapping = [W("keepme", 0.0, 1.0), W("cutme", 0.95, 1.5)];
		const snapped = snapCutToWordGaps({
			start: 1.05,
			end: 1.5,
			words: overlapping,
		});
		expect(snapped).toEqual({ start: 1.0, end: 1.5 });
	});
});
