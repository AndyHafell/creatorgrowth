import { describe, expect, test } from "bun:test";
import { buildDirectorPrompt } from "../director-prompt";
import type { MagicPlanClip } from "../types";

const base = {
	fallback: { clips: [] },
	transcriptLines: ["[0.0–4.2] welcome back to the channel"],
	scopeStart: 0,
	scopeEnd: 120,
};

const prevClip: MagicPlanClip = {
	kind: "reframe",
	start: 110,
	end: 120,
	scale: 1.3,
	focalX: 40,
	focalY: 60,
	easeIn: 0,
	easeOut: 0,
	reason: "code panel left half",
};

describe("buildDirectorPrompt", () => {
	test("covers the scope window and transcript", () => {
		const prompt = buildDirectorPrompt(base);
		expect(prompt).toContain("0.0");
		expect(prompt).toContain("120.0");
		expect(prompt).toContain("welcome back to the channel");
	});

	test("states the browser-chrome exclusion rule", () => {
		const prompt = buildDirectorPrompt(base);
		expect(prompt.toLowerCase()).toContain("url bar");
		expect(prompt.toLowerCase()).toContain("tab bar");
	});

	test("without a previous clip there is no continuity context", () => {
		const prompt = buildDirectorPrompt(base);
		expect(prompt).not.toContain("PREVIOUS WINDOW");
	});

	test("a previous chunk's last clip becomes continuity context", () => {
		const prompt = buildDirectorPrompt({ ...base, previousClip: prevClip });
		expect(prompt).toContain("PREVIOUS WINDOW");
		expect(prompt).toContain("scale 1.3");
		expect(prompt).toContain("code panel left half");
	});

	test("no cursor hints leaves the prompt byte-identical to the v3 prompt", () => {
		const v3 = buildDirectorPrompt(base);
		expect(buildDirectorPrompt({ ...base, cursorHints: [] })).toBe(v3);
		expect(buildDirectorPrompt({ ...base, cursorHints: undefined })).toBe(v3);
		expect(v3).not.toContain("CURSOR HINTS");
	});

	test("cursor hints become a CURSOR HINTS section with the exact lines", () => {
		const prompt = buildDirectorPrompt({
			...base,
			cursorHints: ["- 12.3–13.1s cursor dwelled at (42, 61)% [clicked]"],
		});
		expect(prompt).toContain("CURSOR HINTS");
		expect(prompt).toContain("(42, 61)% [clicked]");
	});

	test("cursor hints scope to zooms/highlights and guard against parked-mouse dwells", () => {
		// r7 eval regression: a dwell on dead space pulled resting reframes off
		// the content (dead framing 0% → 4.5%). Hints must not steer reframes.
		const prompt = buildDirectorPrompt({
			...base,
			cursorHints: ["- 12.3–13.1s cursor dwelled at (42, 61)%"],
		});
		expect(prompt).toContain("never apply to resting reframes");
		expect(prompt.toLowerCase()).toContain("parked");
	});
});
