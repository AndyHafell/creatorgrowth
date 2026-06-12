import { describe, expect, it } from "bun:test";
import {
	type RawCutSegment,
	cutRunEndMediaSec,
	skipDecision,
} from "../segments";

// Minimal segment builder (buffer timebase).
const S = (
	startSec: number,
	endSec: number,
	status: "keep" | "cut",
): RawCutSegment => ({
	id: `${startSec}-${endSec}`,
	startSec,
	endSec,
	status,
	locked: false,
	marked: false,
});

// keep[0,5] · cut[5,6] · keep[6,10]
const basic = () => [S(0, 5, "keep"), S(5, 6, "cut"), S(6, 10, "keep")];

describe("skipDecision", () => {
	it("plays on (continue) when far from any cut boundary", () => {
		expect(
			skipDecision({ segments: basic(), mediaSec: 2, k: 1, leadSec: 0.12 }),
		).toEqual({ action: "continue" });
	});

	it("PREDICTIVELY skips when within lead of a keep→cut boundary", () => {
		// 0.05s before the boundary at 5.0, lead 0.12 → skip now, before any red.
		// Target = start of the post-cut keep (6.0) + a 0.03 nudge inside it.
		expect(
			skipDecision({ segments: basic(), mediaSec: 4.95, k: 1, leadSec: 0.12 }),
		).toEqual({ action: "skip", targetMediaSec: 6.03 });
	});

	it("does NOT predictively skip with leadSec=0 (reactive parity for Raw Cut)", () => {
		// Same spot, but no lead → behaves like the old reactive logic: keep playing
		// until actually inside the cut.
		expect(
			skipDecision({ segments: basic(), mediaSec: 4.95, k: 1, leadSec: 0 }),
		).toEqual({ action: "continue" });
	});

	it("still skips reactively once the playhead is inside a cut (even leadSec=0)", () => {
		expect(
			skipDecision({ segments: basic(), mediaSec: 5.5, k: 1, leadSec: 0 }),
		).toEqual({ action: "skip", targetMediaSec: 6.03 });
	});

	it("does not skip when the next segment is a keep, not a cut", () => {
		const segs = [S(0, 5, "keep"), S(5, 10, "keep")];
		expect(
			skipDecision({ segments: segs, mediaSec: 4.95, k: 1, leadSec: 0.12 }),
		).toEqual({ action: "continue" });
	});

	it("stops when approaching a trailing cut with no keep after it", () => {
		const segs = [S(0, 5, "keep"), S(5, 6, "cut")];
		expect(
			skipDecision({ segments: segs, mediaSec: 4.95, k: 1, leadSec: 0.12 }),
		).toEqual({ action: "stop" });
	});

	it("skips past a run of consecutive cuts to the next keep", () => {
		const segs = [
			S(0, 5, "keep"),
			S(5, 6, "cut"),
			S(6, 7, "cut"),
			S(7, 10, "keep"),
		];
		expect(
			skipDecision({ segments: segs, mediaSec: 4.95, k: 1, leadSec: 0.12 }),
		).toEqual({ action: "skip", targetMediaSec: 7.03 });
	});

	it("converts buffer→media time with k when they drift apart", () => {
		// Segments are buffer-time; media runs 2× longer (k=2). Boundary at buffer 5
		// = media 10; 9.9 is within lead. Target keep starts buffer 6 (+0.03) → media
		// (6.03 * 2) = 12.06.
		expect(
			skipDecision({ segments: basic(), mediaSec: 9.9, k: 2, leadSec: 0.12 }),
		).toEqual({ action: "skip", targetMediaSec: 12.06 });
	});

	// --- play-through: starting playback INSIDE a cut plays through it ---

	it("plays THROUGH the cut you started in (no reactive skip below playThroughUntilSec)", () => {
		// Inside cut[5,6]; we started here, so play to its end (6) instead of skipping.
		expect(
			skipDecision({
				segments: basic(),
				mediaSec: 5.5,
				k: 1,
				leadSec: 0,
				playThroughUntilSec: 6,
			}),
		).toEqual({ action: "continue" });
	});

	it("resumes reactive skipping once past the play-through point", () => {
		// Two cuts. Started in cut[5,6] (playThroughUntilSec=6); now inside a LATER
		// cut[10,11] at 10.5 — past the play-through point → skip normally.
		const segs = [
			S(0, 5, "keep"),
			S(5, 6, "cut"),
			S(6, 10, "keep"),
			S(10, 11, "cut"),
			S(11, 15, "keep"),
		];
		expect(
			skipDecision({
				segments: segs,
				mediaSec: 10.5,
				k: 1,
				leadSec: 0,
				playThroughUntilSec: 6,
			}),
		).toEqual({ action: "skip", targetMediaSec: 11.03 });
	});

	it("still PREDICTIVELY skips a green→red crossing even with playThroughUntilSec set", () => {
		// In green[6,10] approaching cut[10,11]; the play-through suppression only
		// covers the cut we started in, never a fresh green→red boundary.
		const segs = [
			S(0, 5, "keep"),
			S(5, 6, "cut"),
			S(6, 10, "keep"),
			S(10, 11, "cut"),
			S(11, 15, "keep"),
		];
		expect(
			skipDecision({
				segments: segs,
				mediaSec: 9.95,
				k: 1,
				leadSec: 0.12,
				playThroughUntilSec: 6,
			}),
		).toEqual({ action: "skip", targetMediaSec: 11.03 });
	});
});

describe("cutRunEndMediaSec", () => {
	it("returns the media-time end of the cut the playhead is inside", () => {
		expect(cutRunEndMediaSec({ segments: basic(), mediaSec: 5.5, k: 1 })).toBe(
			6,
		);
	});

	it("returns null when the playhead is in a keep (green) segment", () => {
		expect(
			cutRunEndMediaSec({ segments: basic(), mediaSec: 2, k: 1 }),
		).toBeNull();
	});

	it("spans a contiguous RUN of cuts to the run's end", () => {
		const segs = [
			S(0, 5, "keep"),
			S(5, 6, "cut"),
			S(6, 7, "cut"),
			S(7, 10, "keep"),
		];
		expect(cutRunEndMediaSec({ segments: segs, mediaSec: 5.5, k: 1 })).toBe(7);
	});

	it("converts buffer→media with k", () => {
		// k=2: media 11 = buffer 5.5 inside cut[5,6]; end buffer 6 → media 12.
		expect(cutRunEndMediaSec({ segments: basic(), mediaSec: 11, k: 2 })).toBe(
			12,
		);
	});

	it("returns null for empty segments", () => {
		expect(cutRunEndMediaSec({ segments: [], mediaSec: 1, k: 1 })).toBeNull();
	});
});
