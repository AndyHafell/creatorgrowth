import { describe, expect, test } from "bun:test";
import { detectBeats, detectBoundaries } from "../heuristics";
import type { TimelineWord } from "../types";

// Spread a sentence into evenly spaced timeline words starting at t0.
function words(sentence: string, t0 = 0, secondsPerWord = 0.4): TimelineWord[] {
	return sentence.split(/\s+/).map((text, i) => ({
		text,
		start: t0 + i * secondsPerWord,
		end: t0 + i * secondsPerWord + 0.3,
	}));
}

describe("detectBeats", () => {
	test("deictic phrase produces a zoom candidate at the trigger time", () => {
		const w = words("so if you look at this panel you will get it", 20);
		const beats = detectBeats({ words: w });
		expect(beats.length).toBe(1);
		expect(beats[0].kind).toBe("zoom");
		// "look" is word index 3 → 20 + 3*0.4 = 21.2
		expect(beats[0].triggerStart).toBeCloseTo(21.2, 1);
		expect(beats[0].reason.length).toBeGreaterThan(0);
	});

	test("'this prompt' produces a highlight candidate", () => {
		const w = words("this prompt is what makes the whole thing work", 5);
		const beats = detectBeats({ words: w });
		expect(beats.length).toBe(1);
		expect(beats[0].kind).toBe("highlight");
	});

	test("plain narration produces no candidates", () => {
		const w = words(
			"today we are going to build an automation that saves hours",
		);
		expect(detectBeats({ words: w }).length).toBe(0);
	});

	test("direction words near the trigger bias the focal hint", () => {
		const right = detectBeats({
			words: words("on the right side you can see the panel update"),
		});
		expect(right.length).toBe(1);
		expect(right[0].focalHint?.x ?? 50).toBeGreaterThan(55);

		const left = detectBeats({
			words: words("on the left side you can see the menu open"),
		});
		expect(left.length).toBe(1);
		expect(left[0].focalHint?.x ?? 50).toBeLessThan(45);
	});

	test("matching is case and punctuation insensitive", () => {
		const w = words("Look at THIS!");
		expect(detectBeats({ words: w }).length).toBe(1);
	});

	test("overlapping phrase matches collapse to one candidate, highlight preferred", () => {
		const w = words("now look at this prompt for a second here friends");
		const beats = detectBeats({ words: w });
		expect(beats.length).toBe(1);
		expect(beats[0].kind).toBe("highlight");
	});
});

describe("detectBoundaries", () => {
	test("silence gap over the threshold becomes a boundary", () => {
		const w: TimelineWord[] = [
			{ text: "first", start: 0, end: 0.5 },
			{ text: "part", start: 0.6, end: 1.0 },
			{ text: "second", start: 3.0, end: 3.4 }, // 2s gap
			{ text: "part", start: 3.5, end: 3.9 },
		];
		const bounds = detectBoundaries({ words: w });
		expect(bounds.length).toBe(1);
		expect(bounds[0]).toBeGreaterThanOrEqual(1.0);
		expect(bounds[0]).toBeLessThanOrEqual(3.0);
	});

	test("sentence-final punctuation becomes a boundary at the word end", () => {
		const w: TimelineWord[] = [
			{ text: "done.", start: 1, end: 1.5 },
			{ text: "next", start: 1.6, end: 2.0 },
			{ text: "thing", start: 2.1, end: 2.5 },
		];
		const bounds = detectBoundaries({ words: w });
		expect(bounds).toContain(1.5);
	});

	test("continuous unpunctuated speech yields no boundaries, output sorted+deduped", () => {
		const w: TimelineWord[] = [
			{ text: "just", start: 0, end: 0.3 },
			{ text: "keeps", start: 0.4, end: 0.7 },
			{ text: "going", start: 0.8, end: 1.1 },
		];
		expect(detectBoundaries({ words: w }).length).toBe(0);

		const mixed: TimelineWord[] = [
			{ text: "stop.", start: 1, end: 1.5 },
			{ text: "go.", start: 5, end: 5.4 },
			{ text: "end", start: 9, end: 9.3 },
		];
		const bounds = detectBoundaries({ words: mixed });
		const sorted = [...bounds].sort((a, b) => a - b);
		expect(bounds).toEqual(sorted);
		expect(new Set(bounds).size).toBe(bounds.length);
	});
});
