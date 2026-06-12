import { describe, expect, it } from "bun:test";
import {
	clampCutsToRange,
	dedupeCuts,
	planWindows,
	runRawAnalysis,
} from "../raw-analysis";

type TestCut = {
	start: number;
	end: number;
	kind: string;
	reason: string;
	confidence: number;
};

const C = (
	start: number,
	end: number,
	kind = "retake",
	confidence = 0.9,
	reason = "r",
): TestCut => ({ start, end, kind, reason, confidence });

const SEG = (start: number, end: number, text = "line") => ({
	start,
	end,
	text,
});

describe("planWindows", () => {
	it("returns a single full-span window when the file fits in one", () => {
		expect(
			planWindows({ startSec: 0, endSec: 600, windowSec: 720, overlapSec: 60 }),
		).toEqual([{ start: 0, end: 600 }]);
	});

	it("tiles a 65-min file into ~12-min windows with 1-min overlap", () => {
		const wins = planWindows({
			startSec: 0,
			endSec: 3900,
			windowSec: 720,
			overlapSec: 60,
		});
		// stride 660: 0, 660, 1320, 1980, 2640, 3300 → 6 windows
		expect(wins.length).toBe(6);
		expect(wins[0]).toEqual({ start: 0, end: 720 });
		expect(wins[1].start).toBe(660); // 60s overlap with window 0
		expect(wins[wins.length - 1].end).toBe(3900); // last window reaches EOF
		// every adjacent pair overlaps
		for (let i = 1; i < wins.length; i++) {
			expect(wins[i].start).toBeLessThan(wins[i - 1].end);
		}
	});
});

describe("clampCutsToRange", () => {
	it("drops cuts fully outside and clamps partial overlaps", () => {
		const cuts = [C(10, 20), C(100, 130), C(715, 740)];
		const out = clampCutsToRange(cuts, { start: 50, end: 720 });
		expect(out).toEqual([C(100, 130), { ...C(715, 740), end: 720 }]);
	});
});

describe("dedupeCuts", () => {
	it("merges the same cut found by two overlapping windows into one", () => {
		// Window A saw [100, 130], window B saw [102, 133] — one real cut.
		const merged = dedupeCuts([
			C(100, 130, "retake", 0.85),
			C(102, 133, "retake", 0.95),
		]);
		expect(merged.length).toBe(1);
		expect(merged[0].start).toBe(100);
		expect(merged[0].end).toBe(133);
		expect(merged[0].confidence).toBe(0.95);
	});

	it("keeps the higher-priority kind when duplicate kinds differ", () => {
		// marker outranks fluff: the marker call carries the edit intent.
		const merged = dedupeCuts([
			C(100, 130, "fluff", 0.95, "rambling"),
			C(101, 131, "marker", 0.9, "spoken cut command"),
		]);
		expect(merged.length).toBe(1);
		expect(merged[0].kind).toBe("marker");
		expect(merged[0].reason).toBe("spoken cut command");
	});

	it("leaves distinct cuts alone, sorted by start", () => {
		const merged = dedupeCuts([C(500, 520), C(100, 130)]);
		expect(merged.map((c) => c.start)).toEqual([100, 500]);
	});

	it("does NOT merge barely-touching cuts (overlap under half the smaller)", () => {
		// 4s overlap on a 20s and a 30s cut → 4/20 = 0.2 < 0.5 → two real cuts.
		const merged = dedupeCuts([C(100, 120), C(116, 146)]);
		expect(merged.length).toBe(2);
	});
});

describe("runRawAnalysis", () => {
	it("makes a single standard call for a short transcript", async () => {
		const prompts: string[] = [];
		const result = await runRawAnalysis({
			segments: [SEG(0, 5, "hello"), SEG(5, 9, "world")],
			callModel: async (prompt) => {
				prompts.push(prompt);
				return {
					score: 6,
					verdict: "not-greenlit",
					reason: "ok",
					cuts: [C(1, 3)],
				};
			},
		});
		expect(prompts.length).toBe(1);
		expect(prompts[0]).not.toContain("WINDOW");
		expect(prompts[0]).toContain("[0.0-5.0] hello");
		expect(result.cuts.length).toBe(1);
		expect(result.score).toBe(6);
	});

	it("fans a long transcript into window calls plus one whole-file retake pass", async () => {
		// 40 min of one segment per minute.
		const segments = Array.from({ length: 40 }, (_, i) =>
			SEG(i * 60, i * 60 + 50, `minute ${i}`),
		);
		const prompts: string[] = [];
		const result = await runRawAnalysis({
			segments,
			windowSec: 720,
			overlapSec: 60,
			callModel: async (prompt) => {
				prompts.push(prompt);
				if (prompt.includes("RETAKES ONLY")) {
					return {
						score: 5.5,
						verdict: "not-greenlit",
						reason: "whole-file read",
						// Cross-distance retake spanning windows — must survive merge.
						cuts: [C(100, 160, "retake", 0.95, "CTA take 1, redone at 35:00")],
					};
				}
				return {
					score: 9, // window scores must NOT win over the whole-file score
					verdict: "greenlit",
					reason: "window",
					cuts: [C(100, 160, "retake", 0.9, "same cut seen by a window")],
				};
			},
		});
		// 2400s at stride 660 → windows at 0, 660, 1320, 1980 = 4 + 1 retake pass.
		expect(prompts.length).toBe(5);
		const windowPrompts = prompts.filter((p) => p.includes("WINDOW"));
		expect(windowPrompts.length).toBe(4);
		// Window prompts carry only their slice of the transcript.
		expect(windowPrompts[0]).toContain("minute 0");
		expect(windowPrompts[0]).not.toContain("minute 13");
		// Score/verdict/reason come from the whole-file pass.
		expect(result.score).toBe(5.5);
		expect(result.reason).toBe("whole-file read");
		// The duplicate (window + retake pass) merged into one cut.
		expect(result.cuts.length).toBe(1);
		expect(result.cuts[0].confidence).toBe(0.95);
	});

	it("clamps window-call cuts that leak outside their window", async () => {
		const segments = Array.from({ length: 40 }, (_, i) =>
			SEG(i * 60, i * 60 + 50, `minute ${i}`),
		);
		let windowIdx = 0;
		const result = await runRawAnalysis({
			segments,
			windowSec: 720,
			overlapSec: 60,
			callModel: async (prompt) => {
				if (prompt.includes("RETAKES ONLY")) {
					return { score: 5, verdict: "not-greenlit", reason: "", cuts: [] };
				}
				// First window hallucinates a cut at 30:00 (way outside [0, 720]).
				const cuts = windowIdx === 0 ? [C(1800, 1860)] : [];
				windowIdx++;
				return { score: 5, verdict: "not-greenlit", reason: "", cuts };
			},
		});
		expect(result.cuts.length).toBe(0);
	});

	it("sanitizes model junk: bad kinds become fluff, confidence clamped", async () => {
		const result = await runRawAnalysis({
			segments: [SEG(0, 5, "hello")],
			callModel: async () => ({
				score: 99,
				verdict: "greenlit",
				reason: "",
				cuts: [
					{ start: 1, end: 3, kind: "explosion", reason: "", confidence: 7 },
					{ start: 4, end: 2, kind: "retake", reason: "", confidence: 0.9 },
				],
			}),
		});
		expect(result.cuts.length).toBe(1); // end<=start dropped
		expect(result.cuts[0].kind).toBe("fluff");
		expect(result.cuts[0].confidence).toBe(1);
		expect(result.score).toBe(10); // clamped
	});
});
