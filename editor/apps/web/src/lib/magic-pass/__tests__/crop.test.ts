import { describe, expect, test } from "bun:test";
import { cropRectForClip } from "../crop";
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

describe("cropRectForClip", () => {
	test("scale 1 is the full frame", () => {
		const rect = cropRectForClip({
			clip: clip({ scale: 1 }),
			frameW: 1920,
			frameH: 1080,
		});
		expect(rect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
	});

	test("scale 2 centered on 50/50 crops the middle quarter", () => {
		const rect = cropRectForClip({
			clip: clip({ scale: 2, focalX: 50, focalY: 50 }),
			frameW: 1920,
			frameH: 1080,
		});
		expect(rect).toEqual({ x: 480, y: 270, w: 960, h: 540 });
	});

	test("focal at the top-left corner clamps to the frame", () => {
		const rect = cropRectForClip({
			clip: clip({ scale: 2, focalX: 0, focalY: 0 }),
			frameW: 1920,
			frameH: 1080,
		});
		expect(rect).toEqual({ x: 0, y: 0, w: 960, h: 540 });
	});

	test("focal at the bottom-right corner clamps to the frame", () => {
		const rect = cropRectForClip({
			clip: clip({ scale: 2, focalX: 100, focalY: 100 }),
			frameW: 1920,
			frameH: 1080,
		});
		expect(rect).toEqual({ x: 960, y: 540, w: 960, h: 540 });
	});

	test("scale below 1 is treated as full frame", () => {
		const rect = cropRectForClip({
			clip: clip({ scale: 0.5 }),
			frameW: 1920,
			frameH: 1080,
		});
		expect(rect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
	});
});
