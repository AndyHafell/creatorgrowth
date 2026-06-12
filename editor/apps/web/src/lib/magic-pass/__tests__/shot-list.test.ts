import { describe, expect, test } from "bun:test";
import {
	buildShotList,
	directorFrameTimes,
	sanitizeShotList,
	wordsToTranscriptLines,
} from "../shot-list";
import type { BeatCandidate, MagicPlanClip, TimelineWord } from "../types";

function beat(over: Partial<BeatCandidate> = {}): BeatCandidate {
	return {
		kind: "zoom",
		triggerStart: 30,
		triggerEnd: 30.5,
		reason: "mentions 'look at'",
		focalHint: null,
		strength: 2,
		...over,
	};
}

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

/** Every second of [scopeStart, scopeEnd] is inside exactly one clip. */
function expectFullContiguousCoverage(
	clips: MagicPlanClip[],
	scopeStart: number,
	scopeEnd: number,
) {
	expect(clips.length).toBeGreaterThan(0);
	expect(clips[0].start).toBeCloseTo(scopeStart, 5);
	expect(clips[clips.length - 1].end).toBeCloseTo(scopeEnd, 5);
	for (let i = 1; i < clips.length; i++) {
		expect(clips[i].start).toBeCloseTo(clips[i - 1].end, 5);
	}
}

describe("buildShotList", () => {
	test("no beats — reframes cover the whole scope contiguously", () => {
		const plan = buildShotList({
			beats: [],
			scopeStart: 0,
			scopeEnd: 120,
		});
		expectFullContiguousCoverage(plan.clips, 0, 120);
		for (const c of plan.clips) {
			expect(c.kind).toBe("reframe");
			expect(c.end - c.start).toBeGreaterThanOrEqual(2);
			expect(c.end - c.start).toBeLessThanOrEqual(10 + 1e-6);
		}
	});

	test("beats become zoom/highlight clips with reframes filling every gap", () => {
		const plan = buildShotList({
			beats: [
				beat({ triggerStart: 30, triggerEnd: 30.5, kind: "zoom" }),
				beat({ triggerStart: 60, triggerEnd: 60.5, kind: "highlight" }),
			],
			scopeStart: 0,
			scopeEnd: 120,
		});
		expectFullContiguousCoverage(plan.clips, 0, 120);
		expect(plan.clips.some((c) => c.kind === "zoom")).toBe(true);
		expect(plan.clips.some((c) => c.kind === "highlight")).toBe(true);
		expect(plan.clips.some((c) => c.kind === "reframe")).toBe(true);
		// The zoom clip sits on its trigger (with lead-in).
		const zoom = plan.clips.find((c) => c.kind === "zoom");
		expect(zoom).toBeDefined();
		if (!zoom) return;
		expect(zoom.start).toBeLessThanOrEqual(30);
		expect(zoom.end).toBeGreaterThan(30.5);
	});

	test("beats outside the scope are ignored", () => {
		const plan = buildShotList({
			beats: [beat({ triggerStart: 200, triggerEnd: 200.5 })],
			scopeStart: 0,
			scopeEnd: 120,
		});
		expect(plan.clips.every((c) => c.kind === "reframe")).toBe(true);
		expectFullContiguousCoverage(plan.clips, 0, 120);
	});

	test("tiny gap between beat clips is bridged, not given a micro-reframe", () => {
		// Two zooms 5s long with a 1s gap between them (min clip is 2s).
		const plan = buildShotList({
			beats: [
				beat({ triggerStart: 10, triggerEnd: 10.5 }),
				beat({ triggerStart: 16, triggerEnd: 16.5 }),
			],
			scopeStart: 0,
			scopeEnd: 40,
		});
		expectFullContiguousCoverage(plan.clips, 0, 40);
		for (const c of plan.clips) {
			expect(c.end - c.start).toBeGreaterThanOrEqual(2 - 1e-6);
		}
	});

	test("long no-beat stretches split at natural boundaries", () => {
		const plan = buildShotList({
			beats: [],
			boundaries: [7.2, 33.1],
			scopeStart: 0,
			scopeEnd: 40,
		});
		expectFullContiguousCoverage(plan.clips, 0, 40);
		// 7.2 is inside (min=2, max=10) of the first segment — must be a cut.
		expect(plan.clips.some((c) => Math.abs(c.end - 7.2) < 1e-6)).toBe(true);
	});

	test("clustered beats collapse to the strongest", () => {
		const plan = buildShotList({
			beats: [
				beat({ triggerStart: 20, strength: 1, reason: "weak" }),
				beat({ triggerStart: 21, strength: 2, reason: "strong" }),
			],
			scopeStart: 0,
			scopeEnd: 60,
		});
		const zooms = plan.clips.filter((c) => c.kind === "zoom");
		expect(zooms.length).toBe(1);
		expect(zooms[0].reason).toBe("strong");
	});
});

describe("sanitizeShotList", () => {
	test("overlapping clips are trimmed to contiguity, order kept", () => {
		const clips = sanitizeShotList({
			clips: [
				clip({ start: 0, end: 12, kind: "reframe" }),
				clip({ start: 10, end: 20, kind: "zoom", scale: 1.8 }),
			],
			scopeStart: 0,
			scopeEnd: 120,
		});
		expect(clips.length).toBe(2);
		expect(clips[1].start).toBeCloseTo(12, 5);
	});

	test("clips are clamped to scope and sub-second leftovers dropped", () => {
		const clips = sanitizeShotList({
			clips: [
				clip({ start: -5, end: 8 }),
				clip({ start: 119.5, end: 130 }),
				clip({ start: 50, end: 50.4 }),
			],
			scopeStart: 0,
			scopeEnd: 120,
		});
		expect(clips.length).toBe(1);
		expect(clips[0].start).toBe(0);
		expect(clips[0].end).toBe(8);
	});
});

describe("directorFrameTimes", () => {
	test("samples every ~stepSec across the scope, capped at maxFrames", () => {
		const times = directorFrameTimes({
			scopeStart: 0,
			scopeEnd: 120,
			stepSec: 4.5,
			maxFrames: 32,
		});
		expect(times.length).toBeGreaterThan(20);
		expect(times.length).toBeLessThanOrEqual(32);
		expect(times[0]).toBeGreaterThanOrEqual(0);
		expect(times[times.length - 1]).toBeLessThan(120);
		for (let i = 1; i < times.length; i++) {
			expect(times[i]).toBeGreaterThan(times[i - 1]);
		}
	});

	test("long scope widens the step instead of exceeding maxFrames", () => {
		const times = directorFrameTimes({
			scopeStart: 0,
			scopeEnd: 780,
			stepSec: 4.5,
			maxFrames: 32,
		});
		expect(times.length).toBeLessThanOrEqual(32);
		expect(times[times.length - 1]).toBeGreaterThan(700);
	});
});

describe("wordsToTranscriptLines", () => {
	test("groups words into timestamped lines, breaking at sentence ends", () => {
		const words: TimelineWord[] = [
			{ text: "Look", start: 1, end: 1.2 },
			{ text: "at", start: 1.2, end: 1.4 },
			{ text: "this.", start: 1.4, end: 1.8 },
			{ text: "Now", start: 2.2, end: 2.4 },
			{ text: "click", start: 2.4, end: 2.7 },
			{ text: "here.", start: 2.7, end: 3.0 },
		];
		const lines = wordsToTranscriptLines({
			words,
			scopeStart: 0,
			scopeEnd: 120,
		});
		expect(lines.length).toBe(2);
		expect(lines[0]).toContain("Look at this.");
		expect(lines[0]).toMatch(/^\[1\.0[–-]1\.8\]/);
		expect(lines[1]).toContain("Now click here.");
	});

	test("words outside the scope are excluded", () => {
		const words: TimelineWord[] = [
			{ text: "in.", start: 5, end: 5.5 },
			{ text: "out.", start: 130, end: 130.5 },
		];
		const lines = wordsToTranscriptLines({
			words,
			scopeStart: 0,
			scopeEnd: 120,
		});
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("in.");
	});
});
