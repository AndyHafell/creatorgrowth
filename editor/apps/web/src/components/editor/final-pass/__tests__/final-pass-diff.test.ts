import { describe, expect, it } from "bun:test";
import { computeCutDiff } from "../final-pass-diff";

// AI cuts + transcript are MEDIA seconds; segments are BUFFER seconds; k = media/buffer.
const word = (start: number, end: number, text: string) => ({
	start,
	end,
	text,
});
const seg = (startSec: number, endSec: number, status: "keep" | "cut") => ({
	startSec,
	endSec,
	status,
});

describe("computeCutDiff", () => {
	it("flags an OVER-CUT: the AI cut a region the editor kept", () => {
		// AI proposed cutting [5,6]; the editor toggled it back to keep.
		const diff = computeCutDiff({
			aiCuts: [{ start: 5, end: 6 }],
			segments: [seg(0, 5, "keep"), seg(5, 6, "keep"), seg(6, 10, "keep")],
			k: 1,
			transcript: [word(5, 6, "um so basically")],
		});
		expect(diff.overCuts).toEqual([
			{ startSec: 5, endSec: 6, text: "um so basically" },
		]);
		expect(diff.misses).toEqual([]);
	});

	it("flags a MISS: the editor cut a region the AI kept", () => {
		// AI proposed no cuts; the editor cut [2,3].
		const diff = computeCutDiff({
			aiCuts: [],
			segments: [seg(0, 2, "keep"), seg(2, 3, "cut"), seg(3, 10, "keep")],
			k: 1,
			transcript: [word(2, 3, "this part drags")],
		});
		expect(diff.misses).toEqual([
			{ startSec: 2, endSec: 3, text: "this part drags" },
		]);
		expect(diff.overCuts).toEqual([]);
	});

	it("reports NO diff when the editor's cuts match the AI's", () => {
		const diff = computeCutDiff({
			aiCuts: [{ start: 5, end: 6 }],
			segments: [seg(0, 5, "keep"), seg(5, 6, "cut"), seg(6, 10, "keep")],
			k: 1,
			transcript: [word(5, 6, "um so basically")],
		});
		expect(diff).toEqual({ overCuts: [], misses: [] });
	});

	it("converts buffer→media with k for both the diff and the text lookup", () => {
		// Media runs 2× the buffer (k=2). AI cut media [10,12] → buffer mid 5.5,
		// which lands in the kept segment [5,6] → over-cut, text from media range.
		const diff = computeCutDiff({
			aiCuts: [{ start: 10, end: 12 }],
			segments: [seg(0, 5, "keep"), seg(5, 6, "keep"), seg(6, 10, "keep")],
			k: 2,
			transcript: [word(10, 12, "kept on purpose")],
		});
		expect(diff.overCuts).toEqual([
			{ startSec: 10, endSec: 12, text: "kept on purpose" },
		]);
		expect(diff.misses).toEqual([]);
	});
});
