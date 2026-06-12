import { describe, expect, it } from "bun:test";
import {
	type RawCutSegment,
	carryManualEdits,
	sweepCutFrom,
	toggleStatusAt,
} from "../segments";

const S = (
	startSec: number,
	endSec: number,
	status: "keep" | "cut",
	extra: Partial<RawCutSegment> = {},
): RawCutSegment => ({
	id: `${startSec}-${endSec}`,
	startSec,
	endSec,
	status,
	locked: false,
	marked: false,
	...extra,
});

describe("carryManualEdits", () => {
	it("returns next unchanged when prev is empty (first build)", () => {
		const next = [S(0, 5, "keep"), S(5, 6, "cut")];
		expect(carryManualEdits([], next)).toBe(next);
	});

	it("carries lock/mark flags across a rebuild (Raw Cut parity, no status)", () => {
		const prev = [S(0, 5, "keep", { locked: true, marked: true })];
		const next = [S(0, 5, "cut")]; // fresh detection flipped it to cut
		const out = carryManualEdits(prev, next);
		expect(out[0].locked).toBe(true);
		expect(out[0].marked).toBe(true);
		expect(out[0].status).toBe("cut"); // status NOT carried without preserveStatus
	});

	it("carries a userSet segment's status ONLY when preserveStatus is on", () => {
		const prev = [S(5, 6, "keep", { userSet: true })]; // editor kept what AI cut
		const next = [S(5, 6, "cut")]; // re-analyze wants to cut it again
		const preserved = carryManualEdits(prev, next, { preserveStatus: true });
		expect(preserved[0].status).toBe("keep");
		expect(preserved[0].userSet).toBe(true);
	});

	it("does NOT carry status when preserveStatus is off (default)", () => {
		const prev = [S(5, 6, "keep", { userSet: true })];
		const next = [S(5, 6, "cut")];
		expect(carryManualEdits(prev, next)[0].status).toBe("cut");
	});
});

describe("userSet stamping", () => {
	it("toggleStatusAt marks the flipped segment userSet", () => {
		const segs = [S(0, 5, "keep"), S(5, 6, "cut")];
		const out = toggleStatusAt(segs, 1);
		expect(out[1].status).toBe("keep");
		expect(out[1].userSet).toBe(true);
		expect(out[0].userSet).toBeUndefined(); // untouched segment stays clean
	});

	it("sweepCutFrom marks the keep→cut segments userSet", () => {
		const segs = [S(0, 5, "keep"), S(5, 10, "keep")];
		const out = sweepCutFrom(segs, 0);
		expect(out[0].status).toBe("cut");
		expect(out[0].userSet).toBe(true);
		expect(out[1].userSet).toBe(true);
	});
});
