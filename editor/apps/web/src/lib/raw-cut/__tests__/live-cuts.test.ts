import { describe, expect, it } from "bun:test";
import type { ImportedCut } from "../ai-cut";
import { applyLiveCommand, parseLiveCommand } from "../live-cuts";

const R = (start: number, end: number) => ({ start, end });
const FC = (start: number, end: number): ImportedCut => ({
	start,
	end,
	kind: "fluff",
	reason: "",
	confidence: 1,
});

describe("parseLiveCommand", () => {
	it("accepts the five actions and rejects junk", () => {
		expect(
			parseLiveCommand({ action: "set", cuts: [{ start: 1, end: 2 }] })?.action,
		).toBe("set");
		expect(
			parseLiveCommand({ action: "adjust", at: 100, start: 90, end: 105 })
				?.action,
		).toBe("adjust");
		expect(parseLiveCommand({ action: "remove", at: 100 })?.action).toBe(
			"remove",
		);
		expect(parseLiveCommand({ action: "clear" })?.action).toBe("clear");
		expect(parseLiveCommand({ action: "run-ai-cut" })).toEqual({
			action: "run-ai-cut",
			force: false,
		});
		expect(parseLiveCommand({ action: "run-ai-cut", force: true })).toEqual({
			action: "run-ai-cut",
			force: true,
		});
		expect(parseLiveCommand({ action: "explode" })).toBeNull();
		expect(parseLiveCommand({ action: "set", cuts: "nope" })).toBeNull();
		expect(
			parseLiveCommand({ action: "adjust", at: 100, start: 105, end: 90 }),
		).toBeNull();
		expect(parseLiveCommand(null)).toBeNull();
	});

	it("drops invalid cuts inside set/add but keeps the valid ones", () => {
		const cmd = parseLiveCommand({
			action: "add",
			cuts: [
				{ start: 5, end: 9 },
				{ start: 9, end: 2 },
				{ start: "x", end: 3 },
			],
		});
		expect(cmd?.action).toBe("add");
		if (cmd?.action === "add") {
			expect(cmd.cuts.length).toBe(1);
			expect(cmd.cuts[0].start).toBe(5);
			expect(cmd.cuts[0].end).toBe(9);
		}
	});
});

describe("applyLiveCommand", () => {
	const current = () => [R(10, 20), R(100, 160), R(500, 510)];

	it("set replaces the whole list", () => {
		const out = applyLiveCommand(current(), {
			action: "set",
			cuts: [FC(1, 2)],
		});
		expect(out).toEqual([R(1, 2)]);
	});

	it("add appends and merges overlaps", () => {
		const out = applyLiveCommand(current(), {
			action: "add",
			cuts: [FC(15, 30)],
		});
		expect(out).toEqual([R(10, 30), R(100, 160), R(500, 510)]);
	});

	it("adjust rewrites the range containing `at`", () => {
		// "change the cut at 100-160 to be 95-110"
		const out = applyLiveCommand(current(), {
			action: "adjust",
			at: 120,
			start: 95,
			end: 110,
		});
		expect(out).toEqual([R(10, 20), R(95, 110), R(500, 510)]);
	});

	it("adjust with no matching range adds the new one", () => {
		const out = applyLiveCommand(current(), {
			action: "adjust",
			at: 300,
			start: 295,
			end: 310,
		});
		expect(out).toEqual([R(10, 20), R(100, 160), R(295, 310), R(500, 510)]);
	});

	it("remove deletes the range containing `at` (with a small tolerance)", () => {
		// 21 is just outside [10,20] but within the 1s grab tolerance.
		const out = applyLiveCommand(current(), { action: "remove", at: 21 });
		expect(out).toEqual([R(100, 160), R(500, 510)]);
	});

	it("clear empties the list", () => {
		expect(applyLiveCommand(current(), { action: "clear" })).toEqual([]);
	});
});
