import { describe, expect, test } from "bun:test";
import {
	applyCameraToQuad,
	cameraQuadForZoom,
	cameraQuadForZoomProgress,
	easeValue,
	highlightLayout,
	inOutEnvelope,
	zoomEnvelopeProgress,
} from "../camera";

const W = 1920;
const H = 1080;

describe("cameraQuadForZoom", () => {
	test("identity at scale 1", () => {
		const q = cameraQuadForZoom({
			scale: 1,
			focalX: 0.5,
			focalY: 0.5,
			canvasWidth: W,
			canvasHeight: H,
		});
		expect(q.scale).toBe(1);
		expect(q.offsetX).toBe(0);
		expect(q.offsetY).toBe(0);
	});

	test("centered focal at 2x keeps center fixed", () => {
		const q = cameraQuadForZoom({
			scale: 2,
			focalX: 0.5,
			focalY: 0.5,
			canvasWidth: W,
			canvasHeight: H,
		});
		// center point maps to itself: c*s + offset = c
		expect((W / 2) * q.scale + q.offsetX).toBeCloseTo(W / 2);
		expect((H / 2) * q.scale + q.offsetY).toBeCloseTo(H / 2);
	});

	test("corner focal clamps so frame edge stays at frame edge", () => {
		const q = cameraQuadForZoom({
			scale: 2,
			focalX: 0,
			focalY: 0,
			canvasWidth: W,
			canvasHeight: H,
		});
		// top-left of content stays at top-left (window clamped to 0,0)
		expect(0 * q.scale + q.offsetX).toBeCloseTo(0);
		expect(0 * q.scale + q.offsetY).toBeCloseTo(0);
	});

	test("far-corner focal clamps so bottom-right edge stays put", () => {
		const q = cameraQuadForZoom({
			scale: 2,
			focalX: 1,
			focalY: 1,
			canvasWidth: W,
			canvasHeight: H,
		});
		expect(W * q.scale + q.offsetX).toBeCloseTo(W);
		expect(H * q.scale + q.offsetY).toBeCloseTo(H);
	});
});

describe("cameraQuadForZoomProgress", () => {
	test("progress 0 is identity even with off-center focal", () => {
		const q = cameraQuadForZoomProgress({
			targetScale: 3,
			focalX: 0.2,
			focalY: 0.8,
			progress: 0,
			canvasWidth: W,
			canvasHeight: H,
		});
		expect(q.scale).toBeCloseTo(1);
		expect(q.offsetX).toBeCloseTo(0);
		expect(q.offsetY).toBeCloseTo(0);
	});

	test("progress 1 equals the clamped full zoom", () => {
		const full = cameraQuadForZoom({
			scale: 2,
			focalX: 0.3,
			focalY: 0.5,
			canvasWidth: W,
			canvasHeight: H,
		});
		const p = cameraQuadForZoomProgress({
			targetScale: 2,
			focalX: 0.3,
			focalY: 0.5,
			progress: 1,
			canvasWidth: W,
			canvasHeight: H,
		});
		expect(p.scale).toBeCloseTo(full.scale);
		expect(p.offsetX).toBeCloseTo(full.offsetX);
		expect(p.offsetY).toBeCloseTo(full.offsetY);
	});

	test("window edges travel uniformly — no clamp kink for off-center focal", () => {
		// focal toward the left: target window x = clamp(0.3W - W/4, ...) = 0.05W
		const target = {
			targetScale: 2,
			focalX: 0.3,
			focalY: 0.5,
			canvasWidth: W,
			canvasHeight: H,
		};
		const half = cameraQuadForZoomProgress({ ...target, progress: 0.5 });
		// window left edge at progress p is exactly p * targetX — linear, both sides converge together
		const targetX = 0.3 * W - W / 4; // unclamped here = 0.05W
		const windowLeftAtHalf = -half.offsetX / half.scale;
		expect(windowLeftAtHalf).toBeCloseTo(targetX * 0.5);
	});

	test("fully clamped focal (far corner) still interpolates smoothly", () => {
		const q = cameraQuadForZoomProgress({
			targetScale: 2,
			focalX: 0,
			focalY: 0,
			progress: 0.5,
			canvasWidth: W,
			canvasHeight: H,
		});
		// target window pinned at 0,0 — left edge stays at frame edge throughout
		expect(0 * q.scale + q.offsetX).toBeCloseTo(0);
		expect(q.scale).toBeGreaterThan(1);
		expect(q.scale).toBeLessThan(2);
	});
});

describe("applyCameraToQuad", () => {
	test("scales size and remaps center", () => {
		const quad = {
			centerX: 960,
			centerY: 540,
			width: 1920,
			height: 1080,
			rotationDegrees: 0,
			flipX: false,
			flipY: false,
		};
		const cam = { scale: 2, offsetX: -960, offsetY: -540 };
		const out = applyCameraToQuad({ quad, camera: cam });
		expect(out.width).toBe(3840);
		expect(out.height).toBe(2160);
		expect(out.centerX).toBe(960);
		expect(out.centerY).toBe(540);
		expect(out.rotationDegrees).toBe(0);
	});
});

describe("zoomEnvelopeProgress (times in ticks, tps=10)", () => {
	const base = {
		easeInTicks: 10,
		easeOutTicks: 10,
		durationTicks: 100,
		ease: "linear" as const,
	};

	test("in-out: 0 at clip edges, 1 in hold, ramps linearly", () => {
		expect(
			zoomEnvelopeProgress({
				...base,
				mode: "in-out",
				direction: "in",
				localTime: 0,
			}),
		).toBeCloseTo(0);
		expect(
			zoomEnvelopeProgress({
				...base,
				mode: "in-out",
				direction: "in",
				localTime: 50,
			}),
		).toBeCloseTo(1);
		expect(
			zoomEnvelopeProgress({
				...base,
				mode: "in-out",
				direction: "in",
				localTime: 100,
			}),
		).toBeCloseTo(0);
		expect(
			zoomEnvelopeProgress({
				...base,
				mode: "in-out",
				direction: "in",
				localTime: 5,
			}),
		).toBeCloseTo(0.5);
	});

	test("in-out: ramps compress when clip shorter than easeIn+easeOut", () => {
		const p = zoomEnvelopeProgress({
			...base,
			durationTicks: 10,
			mode: "in-out",
			direction: "in",
			localTime: 5,
		});
		expect(p).toBeCloseTo(1); // 5 ticks in, 5 ticks out
	});

	test("continuous in: 0 -> 1 across the clip", () => {
		expect(
			zoomEnvelopeProgress({
				...base,
				mode: "continuous",
				direction: "in",
				localTime: 0,
			}),
		).toBeCloseTo(0);
		expect(
			zoomEnvelopeProgress({
				...base,
				mode: "continuous",
				direction: "in",
				localTime: 100,
			}),
		).toBeCloseTo(1);
	});

	test("continuous out: 1 -> 0 across the clip", () => {
		expect(
			zoomEnvelopeProgress({
				...base,
				mode: "continuous",
				direction: "out",
				localTime: 0,
			}),
		).toBeCloseTo(1);
		expect(
			zoomEnvelopeProgress({
				...base,
				mode: "continuous",
				direction: "out",
				localTime: 100,
			}),
		).toBeCloseTo(0);
	});
});

describe("inOutEnvelope", () => {
	test("0 at edges, 1 in hold, symmetric ramps", () => {
		const p = { rampTicks: 10, durationTicks: 100 };
		expect(inOutEnvelope({ ...p, localTime: 0 })).toBeCloseTo(0);
		expect(inOutEnvelope({ ...p, localTime: 10 })).toBeCloseTo(1);
		expect(inOutEnvelope({ ...p, localTime: 50 })).toBeCloseTo(1);
		expect(inOutEnvelope({ ...p, localTime: 100 })).toBeCloseTo(0);
	});
});

describe("easeValue", () => {
	test("clamps and hits endpoints", () => {
		for (const ease of ["linear", "smooth", "snappy"] as const) {
			expect(easeValue({ t: 0, ease })).toBeCloseTo(0);
			expect(easeValue({ t: 1, ease })).toBeCloseTo(1);
			expect(easeValue({ t: -1, ease })).toBeCloseTo(0);
			expect(easeValue({ t: 2, ease })).toBeCloseTo(1);
		}
	});
});

describe("highlightLayout", () => {
	const region = { x: 0.5, y: 0.5, w: 0.25, h: 0.25 };
	test("progress 0 = cutout in place at natural scale", () => {
		const l = highlightLayout({
			region,
			size: 0.65,
			progress: 0,
			canvasWidth: W,
			canvasHeight: H,
		});
		expect(l.dstRect.x).toBeCloseTo(region.x * W);
		expect(l.dstRect.w).toBeCloseTo(region.w * W);
		expect(l.camera.scale).toBeCloseTo(1);
	});
	test("progress 1 = cutout centered, filling `size` of the frame", () => {
		const l = highlightLayout({
			region,
			size: 0.65,
			progress: 1,
			canvasWidth: W,
			canvasHeight: H,
		});
		const s = Math.min(
			(0.65 * W) / (region.w * W),
			(0.65 * H) / (region.h * H),
		);
		expect(l.camera.scale).toBeCloseTo(s);
		expect(l.dstRect.x + l.dstRect.w / 2).toBeCloseTo(W / 2);
		expect(l.dstRect.y + l.dstRect.h / 2).toBeCloseTo(H / 2);
	});
	test("camera maps srcRect onto dstRect", () => {
		const l = highlightLayout({
			region,
			size: 0.65,
			progress: 1,
			canvasWidth: W,
			canvasHeight: H,
		});
		const srcCx = (region.x + region.w / 2) * W;
		expect(srcCx * l.camera.scale + l.camera.offsetX).toBeCloseTo(
			l.dstRect.x + l.dstRect.w / 2,
		);
	});
});
