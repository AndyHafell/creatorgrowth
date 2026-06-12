import { describe, expect, test } from "bun:test";
import { candidatesToPlan, planClipToElementSpec } from "../plan";
import type { BeatCandidate, MagicPlanClip } from "../types";

const TPS = 705_600_000;

function cand(over: Partial<BeatCandidate> = {}): BeatCandidate {
	return {
		kind: "zoom",
		triggerStart: 10,
		triggerEnd: 10.5,
		reason: "mentions 'look at'",
		focalHint: null,
		strength: 1,
		...over,
	};
}

describe("candidatesToPlan", () => {
	test("well-spaced candidates each become a clip, sorted, no overlap", () => {
		const plan = candidatesToPlan({
			candidates: [
				cand({ triggerStart: 30, triggerEnd: 30.4 }),
				cand({ triggerStart: 10, triggerEnd: 10.4 }),
			],
			durationSec: 120,
		});
		expect(plan.clips.length).toBe(2);
		expect(plan.clips[0].start).toBeLessThan(plan.clips[1].start);
		for (let i = 1; i < plan.clips.length; i++) {
			expect(plan.clips[i].start).toBeGreaterThanOrEqual(plan.clips[i - 1].end);
		}
	});

	test("clustered candidates collapse to one clip keeping the stronger", () => {
		const plan = candidatesToPlan({
			candidates: [
				cand({ triggerStart: 10, strength: 1, reason: "weak" }),
				cand({ triggerStart: 11, strength: 2, reason: "strong" }),
			],
			durationSec: 120,
		});
		expect(plan.clips.length).toBe(1);
		expect(plan.clips[0].reason).toBe("strong");
	});

	test("near-collisions truncate the earlier clip but keep both when room allows", () => {
		const plan = candidatesToPlan({
			candidates: [
				cand({ triggerStart: 10 }),
				// 4.5s later: inside the default 5s zoom clip, outside the cluster window.
				cand({ triggerStart: 14.5 }),
			],
			durationSec: 120,
		});
		expect(plan.clips.length).toBe(2);
		expect(plan.clips[1].start).toBeGreaterThanOrEqual(plan.clips[0].end);
		// Earlier clip stays a sane length.
		expect(plan.clips[0].end - plan.clips[0].start).toBeGreaterThanOrEqual(2);
	});

	test("clips clamp inside [0, duration]", () => {
		const plan = candidatesToPlan({
			candidates: [
				cand({ triggerStart: 0.1 }),
				cand({ triggerStart: 118.9, triggerEnd: 119.2 }),
			],
			durationSec: 120,
		});
		for (const clip of plan.clips) {
			expect(clip.start).toBeGreaterThanOrEqual(0);
			expect(clip.end).toBeLessThanOrEqual(120);
		}
	});

	test("density is capped for long videos", () => {
		const candidates = Array.from({ length: 80 }, (_, i) =>
			cand({ triggerStart: 5 + i * 9, triggerEnd: 5.4 + i * 9 }),
		);
		const plan = candidatesToPlan({ candidates, durationSec: 780 });
		expect(plan.clips.length).toBeLessThanOrEqual(36);
		expect(plan.clips.length).toBeGreaterThan(5);
	});

	test("zoom clips get scale + focal defaults, highlight clips get a region", () => {
		const plan = candidatesToPlan({
			candidates: [
				cand({ triggerStart: 10, kind: "zoom", focalHint: { x: 75, y: 50 } }),
				cand({ triggerStart: 40, kind: "highlight" }),
			],
			durationSec: 120,
		});
		const zoom = plan.clips[0];
		expect(zoom.kind).toBe("zoom");
		expect(zoom.scale).toBeGreaterThan(1);
		expect(zoom.focalX).toBe(75);
		const hl = plan.clips[1];
		expect(hl.kind).toBe("highlight");
		expect(hl.region).toBeDefined();
		expect(hl.region!.w).toBeGreaterThan(0);
	});
});

describe("planClipToElementSpec", () => {
	const zoomClip: MagicPlanClip = {
		kind: "zoom",
		start: 10,
		end: 15,
		scale: 2,
		focalX: 70,
		focalY: 40,
		easeIn: 0.5,
		easeOut: 0.5,
		reason: "mentions 'look at'",
	};

	test("converts seconds to ticks and maps zoom params", () => {
		const spec = planClipToElementSpec({ clip: zoomClip, ticksPerSecond: TPS });
		expect(spec.effectType).toBe("magic-zoom");
		expect(spec.startTime).toBe(10 * TPS);
		expect(spec.duration).toBe(5 * TPS);
		expect(spec.params.scale).toBe(2);
		expect(spec.params.focalX).toBe(70);
		expect(spec.params.focalY).toBe(40);
		expect(spec.params.easeIn).toBe(0.5);
		expect(spec.name).toContain("look at");
	});

	test("maps highlight region to percent params", () => {
		const spec = planClipToElementSpec({
			clip: {
				kind: "highlight",
				start: 20,
				end: 24,
				scale: 1,
				focalX: 50,
				focalY: 50,
				region: { x: 10, y: 20, w: 40, h: 30 },
				easeIn: 0.5,
				easeOut: 0.5,
				reason: "mentions 'this prompt'",
			},
			ticksPerSecond: TPS,
		});
		expect(spec.effectType).toBe("magic-highlight");
		expect(spec.params.regionX).toBe(10);
		expect(spec.params.regionY).toBe(20);
		expect(spec.params.regionW).toBe(40);
		expect(spec.params.regionH).toBe(30);
	});

	test("short clips get eases scaled down to fit", () => {
		const spec = planClipToElementSpec({
			clip: { ...zoomClip, start: 10, end: 11, easeIn: 0.5, easeOut: 0.5 },
			ticksPerSecond: TPS,
		});
		const easeIn = spec.params.easeIn as number;
		const easeOut = spec.params.easeOut as number;
		expect(easeIn + easeOut).toBeLessThanOrEqual(0.8 + 1e-9);
	});
});

describe("planClipToElementSpec — reframe", () => {
	test("reframe clip maps to a magic-reframe element with locked-framing params", () => {
		const spec = planClipToElementSpec({
			clip: {
				kind: "reframe",
				start: 12,
				end: 20,
				scale: 1.4,
				focalX: 30,
				focalY: 60,
				easeIn: 0,
				easeOut: 0,
				reason: "resting on the code panel",
			},
			ticksPerSecond: TPS,
		});
		expect(spec.effectType).toBe("magic-reframe");
		expect(spec.params.scale).toBe(1.4);
		expect(spec.params.focalX).toBe(30);
		expect(spec.params.focalY).toBe(60);
		expect(spec.params.easeIn).toBeUndefined();
		expect(spec.startTime).toBe(12 * TPS);
		expect(spec.duration).toBe(8 * TPS);
		expect(spec.name).toBe("Magic: resting on the code panel");
	});
});
