import { describe, expect, test } from "bun:test";
import type { EffectTrack, TextTrack } from "@/lib/timeline/types";
import {
	clampNudge,
	clipIndexAtTime,
	collectEffectClips,
	magicParamsForKind,
	nextClipIndex,
	prevClipIndex,
	type ReviewClip,
} from "@/lib/timeline/effect-review";

function buildEffectTrack({
	id,
	clips,
}: {
	id: string;
	clips: Array<{ id: string; startTime: number; duration: number }>;
}): EffectTrack {
	return {
		id,
		name: `Effects ${id}`,
		type: "effect",
		hidden: false,
		elements: clips.map(({ id: elementId, startTime, duration }) => ({
			id: elementId,
			name: `Magic ${elementId}`,
			type: "effect",
			effectType: "magic-zoom",
			params: {},
			startTime,
			duration,
			trimStart: 0,
			trimEnd: 0,
		})),
	};
}

function buildTextTrack({ id }: { id: string }): TextTrack {
	return {
		id,
		name: `Text ${id}`,
		type: "text",
		hidden: false,
		elements: [],
	};
}

function clip({
	trackId,
	elementId,
	startTime,
	endTime,
}: {
	trackId: string;
	elementId: string;
	startTime: number;
	endTime: number;
}): ReviewClip {
	return {
		trackId,
		elementId,
		startTime,
		endTime,
		name: `Magic ${elementId}`,
		effectType: "magic-zoom",
	};
}

describe("collectEffectClips", () => {
	test("flattens effect tracks and sorts clips by startTime", () => {
		const overlay = [
			buildEffectTrack({
				id: "fx-1",
				clips: [
					{ id: "b", startTime: 500, duration: 100 },
					{ id: "a", startTime: 100, duration: 100 },
				],
			}),
			buildTextTrack({ id: "text-1" }),
			buildEffectTrack({
				id: "fx-2",
				clips: [{ id: "c", startTime: 300, duration: 100 }],
			}),
		];

		const clips = collectEffectClips({ overlay });

		expect(clips.map((c) => c.elementId)).toEqual(["a", "c", "b"]);
		expect(clips[0]).toEqual({
			trackId: "fx-1",
			elementId: "a",
			startTime: 100,
			endTime: 200,
			name: "Magic a",
			effectType: "magic-zoom",
		});
	});

	test("returns empty array when no effect tracks exist", () => {
		expect(
			collectEffectClips({ overlay: [buildTextTrack({ id: "text-1" })] }),
		).toEqual([]);
	});
});

describe("clipIndexAtTime", () => {
	const clips = [
		clip({ trackId: "t", elementId: "a", startTime: 100, endTime: 200 }),
		clip({ trackId: "t", elementId: "b", startTime: 300, endTime: 400 }),
	];

	test("returns the clip whose span contains the time", () => {
		expect(clipIndexAtTime({ clips, time: 150 })).toBe(0);
		expect(clipIndexAtTime({ clips, time: 350 })).toBe(1);
	});

	test("treats the span as start-inclusive, end-exclusive", () => {
		expect(clipIndexAtTime({ clips, time: 100 })).toBe(0);
		expect(clipIndexAtTime({ clips, time: 200 })).toBe(-1);
	});

	test("returns -1 outside every clip", () => {
		expect(clipIndexAtTime({ clips, time: 50 })).toBe(-1);
		expect(clipIndexAtTime({ clips, time: 250 })).toBe(-1);
		expect(clipIndexAtTime({ clips: [], time: 100 })).toBe(-1);
	});
});

describe("nextClipIndex / prevClipIndex", () => {
	const clips = [
		clip({ trackId: "t", elementId: "a", startTime: 100, endTime: 200 }),
		clip({ trackId: "t", elementId: "b", startTime: 300, endTime: 400 }),
		clip({ trackId: "t", elementId: "c", startTime: 500, endTime: 600 }),
	];

	test("next: first clip starting strictly after the time", () => {
		expect(nextClipIndex({ clips, time: 0 })).toBe(0);
		expect(nextClipIndex({ clips, time: 150 })).toBe(1);
		expect(nextClipIndex({ clips, time: 300 })).toBe(2);
		expect(nextClipIndex({ clips, time: 550 })).toBe(-1);
	});

	test("prev mid-clip rewinds to that clip's own start", () => {
		expect(prevClipIndex({ clips, time: 350 })).toBe(1);
	});

	test("prev at a clip's exact start steps to the previous clip", () => {
		expect(prevClipIndex({ clips, time: 300 })).toBe(0);
		expect(prevClipIndex({ clips, time: 100 })).toBe(-1);
	});

	test("prev before all clips returns -1", () => {
		expect(prevClipIndex({ clips, time: 50 })).toBe(-1);
	});
});

describe("clampNudge", () => {
	const target = clip({
		trackId: "t",
		elementId: "b",
		startTime: 300,
		endTime: 400,
	});
	const clips = [
		clip({ trackId: "t", elementId: "a", startTime: 100, endTime: 250 }),
		target,
		clip({ trackId: "t", elementId: "c", startTime: 480, endTime: 600 }),
	];

	test("passes the delta through when there is room", () => {
		expect(clampNudge({ clip: target, clips, delta: 50 })).toBe(50);
		expect(clampNudge({ clip: target, clips, delta: -30 })).toBe(-30);
	});

	test("clamps right movement at the next clip's start", () => {
		expect(clampNudge({ clip: target, clips, delta: 200 })).toBe(80);
	});

	test("clamps left movement at the previous clip's end", () => {
		expect(clampNudge({ clip: target, clips, delta: -200 })).toBe(-50);
	});

	test("clamps at timeline start when there is no previous clip", () => {
		const solo = clip({
			trackId: "t",
			elementId: "only",
			startTime: 40,
			endTime: 90,
		});
		expect(clampNudge({ clip: solo, clips: [solo], delta: -100 })).toBe(-40);
	});

	test("clips on other tracks do not constrain the nudge", () => {
		const otherTrack = clip({
			trackId: "other",
			elementId: "z",
			startTime: 390,
			endTime: 450,
		});
		expect(
			clampNudge({ clip: target, clips: [target, otherTrack], delta: 200 }),
		).toBe(200);
	});
});

describe("magicParamsForKind", () => {
	test("zoom → highlight builds a region centered on the focal", () => {
		const out = magicParamsForKind({
			fromEffectType: "magic-zoom",
			params: { mode: "in-out", scale: 2.2, focalX: 60, focalY: 40, easeIn: 0.5, easeOut: 0.5 },
			targetKind: "highlight",
		});
		expect(out.effectType).toBe("magic-highlight");
		expect(out.params.regionX).toBe(40);
		expect(out.params.regionY).toBe(25);
		expect(out.params.regionW).toBe(40);
		expect(out.params.regionH).toBe(30);
	});

	test("highlight → zoom focal is the region center, scale at least 1.8", () => {
		const out = magicParamsForKind({
			fromEffectType: "magic-highlight",
			params: { regionX: 20, regionY: 30, regionW: 40, regionH: 30, transition: 0.5 },
			targetKind: "zoom",
		});
		expect(out.effectType).toBe("magic-zoom");
		expect(out.params.focalX).toBe(40);
		expect(out.params.focalY).toBe(45);
		expect(out.params.scale).toBe(1.8);
		expect(out.params.mode).toBe("in-out");
	});

	test("zoom → reframe keeps scale and focal, reframe → zoom tightens to 1.8 minimum", () => {
		const toReframe = magicParamsForKind({
			fromEffectType: "magic-zoom",
			params: { mode: "in-out", scale: 2.4, focalX: 30, focalY: 70, easeIn: 0.5, easeOut: 0.5 },
			targetKind: "reframe",
		});
		expect(toReframe.effectType).toBe("magic-reframe");
		expect(toReframe.params.scale).toBe(2.4);
		expect(toReframe.params.focalX).toBe(30);

		const toZoom = magicParamsForKind({
			fromEffectType: "magic-reframe",
			params: { scale: 1.3, focalX: 50, focalY: 50 },
			targetKind: "zoom",
		});
		expect(toZoom.params.scale).toBe(1.8);
	});

	test("region clamps so the highlight box stays on screen", () => {
		const out = magicParamsForKind({
			fromEffectType: "magic-reframe",
			params: { scale: 1.3, focalX: 95, focalY: 5 },
			targetKind: "highlight",
		});
		expect(out.params.regionX).toBe(60);
		expect(out.params.regionY).toBe(0);
	});
});
