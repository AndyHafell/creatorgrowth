import { describe, expect, test } from "bun:test";
import { pacingStats } from "../pacing";
import type { MagicPlanClip } from "../types";

function clip(over: Partial<MagicPlanClip> = {}): MagicPlanClip {
	return {
		kind: "reframe",
		start: 0,
		end: 5,
		scale: 1.3,
		focalX: 50,
		focalY: 50,
		easeIn: 0,
		easeOut: 0,
		reason: "resting",
		...over,
	};
}

describe("pacingStats", () => {
	test("empty shot list yields zeroed stats", () => {
		const stats = pacingStats({ clips: [], scopeStart: 0, scopeEnd: 60 });
		expect(stats.clipCount).toBe(0);
		expect(stats.clipsPerMin).toBe(0);
		expect(stats.meanHoldSec).toBe(0);
		expect(stats.coveragePct).toBe(0);
		expect(stats.maxConsecutiveZooms).toBe(0);
	});

	test("counts, coverage and mean hold over a known list", () => {
		const stats = pacingStats({
			clips: [
				clip({ start: 0, end: 10 }),
				clip({ kind: "zoom", start: 10, end: 15, scale: 2 }),
				clip({ start: 15, end: 30 }),
			],
			scopeStart: 0,
			scopeEnd: 60,
		});
		expect(stats.clipCount).toBe(3);
		expect(stats.kindCounts).toEqual({ reframe: 2, zoom: 1, highlight: 0 });
		expect(stats.coveragePct).toBeCloseTo(50, 5);
		expect(stats.meanHoldSec).toBeCloseTo(10, 5);
		expect(stats.clipsPerMin).toBeCloseTo(3, 5);
	});

	test("longest consecutive zoom/highlight run is measured", () => {
		const stats = pacingStats({
			clips: [
				clip({ kind: "zoom", start: 0, end: 3 }),
				clip({ kind: "zoom", start: 3, end: 6 }),
				clip({ kind: "highlight", start: 6, end: 9 }),
				clip({ start: 9, end: 18 }),
				clip({ kind: "zoom", start: 18, end: 21 }),
			],
			scopeStart: 0,
			scopeEnd: 21,
		});
		expect(stats.maxConsecutiveZooms).toBe(3);
	});

	test("share of time spent at full frame (scale 1) is reported", () => {
		const stats = pacingStats({
			clips: [
				clip({ start: 0, end: 30, scale: 1 }),
				clip({ start: 30, end: 60, scale: 1.4 }),
			],
			scopeStart: 0,
			scopeEnd: 60,
		});
		expect(stats.fullFrameTimePct).toBeCloseTo(50, 5);
	});

	test("share of short holds (under 3s) is reported", () => {
		const stats = pacingStats({
			clips: [
				clip({ start: 0, end: 2 }),
				clip({ start: 2, end: 12 }),
				clip({ start: 12, end: 14 }),
				clip({ start: 14, end: 24 }),
			],
			scopeStart: 0,
			scopeEnd: 24,
		});
		expect(stats.shortHoldPct).toBeCloseTo(50, 5);
	});
});
