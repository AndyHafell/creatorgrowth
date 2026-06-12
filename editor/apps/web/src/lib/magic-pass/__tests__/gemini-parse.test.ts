import { describe, expect, test } from "bun:test";
import { parseRefinedPlan } from "../gemini-parse";
import type { MagicPlan } from "../types";

const base: MagicPlan = {
	clips: [
		{
			kind: "zoom",
			start: 10,
			end: 15,
			scale: 1.8,
			focalX: 50,
			focalY: 50,
			easeIn: 0.5,
			easeOut: 0.5,
			reason: "heuristic",
		},
	],
};

describe("parseRefinedPlan", () => {
	test("parses a valid refined plan and clamps values", () => {
		const text = JSON.stringify({
			clips: [
				{
					kind: "zoom",
					start: 10,
					end: 15,
					scale: 9, // out of range → clamp to 3 (documented zoom ceiling)
					focalX: 130, // → 100
					focalY: -10, // → 0
					easeIn: 0.5,
					easeOut: 0.5,
					reason: "button on the right",
				},
			],
		});
		const plan = parseRefinedPlan({ text, fallback: base });
		expect(plan.clips.length).toBe(1);
		expect(plan.clips[0].scale).toBe(3);
		expect(plan.clips[0].focalX).toBe(100);
		expect(plan.clips[0].focalY).toBe(0);
		expect(plan.clips[0].reason).toBe("button on the right");
	});

	test("strips markdown fences", () => {
		const text =
			'```json\n{"clips":[{"kind":"highlight","start":1,"end":4,"region":{"x":10,"y":10,"w":50,"h":40},"reason":"code line"}]}\n```';
		const plan = parseRefinedPlan({ text, fallback: base });
		expect(plan.clips[0].kind).toBe("highlight");
		expect(plan.clips[0].region?.w).toBe(50);
	});

	test("falls back on garbage", () => {
		const plan = parseRefinedPlan({
			text: "sorry, here you go!",
			fallback: base,
		});
		expect(plan).toEqual(base);
	});

	test("drops invalid clips, keeps valid ones, defaults missing eases", () => {
		const text = JSON.stringify({
			clips: [
				{ kind: "sparkle", start: 1, end: 3, reason: "nope" },
				{ kind: "zoom", start: 3, end: 2, reason: "inverted" },
				{ kind: "zoom", start: 5, end: 9, scale: 2, reason: "ok" },
			],
		});
		const plan = parseRefinedPlan({ text, fallback: base });
		expect(plan.clips.length).toBe(1);
		expect(plan.clips[0].reason).toBe("ok");
		expect(plan.clips[0].easeIn).toBe(0.5);
	});
});

describe("parseRefinedPlan — reframe kind", () => {
	test("reframe clips parse with clamped scale and focal point", () => {
		const text = JSON.stringify({
			clips: [
				{
					kind: "reframe",
					start: 0,
					end: 8,
					scale: 1.4,
					focalX: 25,
					focalY: 50,
					reason: "left half",
				},
			],
		});
		const plan = parseRefinedPlan({ text, fallback: base });
		expect(plan.clips.length).toBe(1);
		expect(plan.clips[0].kind).toBe("reframe");
		expect(plan.clips[0].scale).toBe(1.4);
		expect(plan.clips[0].focalX).toBe(25);
	});
});
