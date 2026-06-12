import { describe, expect, it } from "bun:test";
import { mergeShortKeepIslands } from "../final-pass-denoise";

// A transcript word/segment with absolute media-second timing.
const seg = (start: number, end: number, text: string) => ({
	start,
	end,
	text,
});

describe("mergeShortKeepIslands", () => {
	it("merges a one-word green island between two cuts into one cut", () => {
		// Two cuts with a ~0.6s keep gap [5.0, 5.6] holding a single word "um".
		const cuts = [
			{ start: 2, end: 5, reason: "filler", kind: "filler" as const },
			{ start: 5.6, end: 9, reason: "fluff", kind: "fluff" as const },
		];
		const segments = [seg(5.0, 5.6, "um")];
		const out = mergeShortKeepIslands({ cuts, segments });
		expect(out).toEqual([
			{ start: 2, end: 9, reason: "filler", kind: "filler" },
		]);
	});

	it("merges a sub-threshold-duration gap even when it holds several words", () => {
		// 0.3s gap (< 0.4s) — too short to be a real keep regardless of word count.
		const cuts = [
			{ start: 0, end: 4 },
			{ start: 4.3, end: 8 },
		];
		const segments = [seg(4.0, 4.3, "one two three four")];
		const out = mergeShortKeepIslands({ cuts, segments });
		expect(out).toEqual([{ start: 0, end: 8 }]);
	});

	it("keeps a legitimate green island (long enough AND enough words)", () => {
		// 1.2s gap with 5 words — a real kept clip, must survive.
		const cuts = [
			{ start: 0, end: 4 },
			{ start: 5.2, end: 8 },
		];
		const segments = [seg(4.0, 5.2, "this is a real sentence")];
		const out = mergeShortKeepIslands({ cuts, segments });
		expect(out).toEqual([
			{ start: 0, end: 4 },
			{ start: 5.2, end: 8 },
		]);
	});

	it("never merges the leading or trailing keep (only islands BETWEEN cuts)", () => {
		// One cut only — the keep before it and after it are not islands.
		const cuts = [{ start: 5, end: 6 }];
		const segments = [seg(0, 5, "intro words here"), seg(6, 10, "outro words")];
		const out = mergeShortKeepIslands({ cuts, segments });
		expect(out).toEqual([{ start: 5, end: 6 }]);
	});

	it("collapses a run of consecutive tiny islands into a single cut", () => {
		const cuts = [
			{ start: 0, end: 2 },
			{ start: 2.2, end: 4 },
			{ start: 4.2, end: 6 },
		];
		const segments = [seg(2.0, 2.2, "a"), seg(4.0, 4.2, "b")];
		const out = mergeShortKeepIslands({ cuts, segments });
		expect(out).toEqual([{ start: 0, end: 6 }]);
	});

	it("sorts unsorted cuts and leaves real keeps split", () => {
		const cuts = [
			{ start: 5.2, end: 8 },
			{ start: 0, end: 4 },
		];
		const segments = [seg(4.0, 5.2, "a genuine spoken clip here")];
		const out = mergeShortKeepIslands({ cuts, segments });
		expect(out).toEqual([
			{ start: 0, end: 4 },
			{ start: 5.2, end: 8 },
		]);
	});

	it("returns an empty list unchanged", () => {
		expect(mergeShortKeepIslands({ cuts: [], segments: [] })).toEqual([]);
	});

	it("respects custom thresholds", () => {
		// A 0.6s, 3-word gap survives the defaults but merges when maxKeepWords=3.
		const cuts = [
			{ start: 0, end: 4 },
			{ start: 4.6, end: 8 },
		];
		const segments = [seg(4.0, 4.6, "one two three")];
		expect(mergeShortKeepIslands({ cuts, segments })).toEqual([
			{ start: 0, end: 4 },
			{ start: 4.6, end: 8 },
		]);
		expect(mergeShortKeepIslands({ cuts, segments, maxKeepWords: 3 })).toEqual([
			{ start: 0, end: 8 },
		]);
	});
});
