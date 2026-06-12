import { describe, expect, test } from "bun:test";
import { clampBrowserChrome } from "../chrome-clamp";
import { parseRefinedPlan } from "../gemini-parse";
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

describe("clampBrowserChrome", () => {
	test("browser clip with focalY too high gets pushed below the chrome", () => {
		// scale 1.8 → min focalY = 13 + 50/1.8 ≈ 40.8; director said 30.
		const [out] = clampBrowserChrome([
			clip({ kind: "zoom", scale: 1.8, focalY: 30, browser: true }),
		]);
		expect(out.focalY).toBeCloseTo(13 + 50 / 1.8, 1);
	});

	test("browser clip already below the chrome is untouched", () => {
		const [out] = clampBrowserChrome([
			clip({ scale: 1.5, focalY: 60, browser: true }),
		]);
		expect(out.focalY).toBe(60);
	});

	test("non-browser clips are untouched even with high focalY", () => {
		const [out] = clampBrowserChrome([clip({ scale: 2, focalY: 10 })]);
		expect(out.focalY).toBe(10);
	});

	test("full-frame browser clip gets a minimum push-in so chrome can crop off", () => {
		const [out] = clampBrowserChrome([
			clip({ scale: 1, focalY: 50, browser: true }),
		]);
		expect(out.scale).toBeGreaterThanOrEqual(1.15);
		expect(out.focalY).toBeGreaterThanOrEqual(13 + 50 / out.scale - 0.001);
	});

	test("highlight clips are left alone", () => {
		const [out] = clampBrowserChrome([
			clip({ kind: "highlight", scale: 1, focalY: 20, browser: true }),
		]);
		expect(out.scale).toBe(1);
		expect(out.focalY).toBe(20);
	});
});

describe("parseRefinedPlan scale ceiling", () => {
	test("director scales above 3 are clamped to the documented max", () => {
		const plan = parseRefinedPlan({
			text: '{"clips":[{"kind":"reframe","start":0,"end":8,"scale":4,"focalX":50,"focalY":90,"easeIn":0,"easeOut":0,"reason":"webcam tile"}]}',
			fallback: { clips: [] },
		});
		expect(plan.clips[0].scale).toBe(3);
	});
});

describe("parseRefinedPlan browser flag", () => {
	test("browser:true survives the defensive parse", () => {
		const plan = parseRefinedPlan({
			text: '{"clips":[{"kind":"reframe","start":0,"end":8,"scale":1.4,"focalX":50,"focalY":55,"easeIn":0,"easeOut":0,"reason":"article text","browser":true}]}',
			fallback: { clips: [] },
		});
		expect(plan.clips[0].browser).toBe(true);
	});

	test("missing browser flag stays undefined", () => {
		const plan = parseRefinedPlan({
			text: '{"clips":[{"kind":"reframe","start":0,"end":8,"scale":1.4,"focalX":50,"focalY":55,"easeIn":0,"easeOut":0,"reason":"webcam"}]}',
			fallback: { clips: [] },
		});
		expect(plan.clips[0].browser).toBeUndefined();
	});
});
