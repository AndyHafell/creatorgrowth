import { describe, expect, test } from "bun:test";
import {
	clampDeltaMs,
	createSpringState,
	createZoomSpringState,
	getZoomSpringConfig,
	isZoomSpringAtRest,
	resetZoomSpring,
	stepSpringValue,
	stepZoomSpring,
} from "../spring";

const FRAME_MS = 1000 / 60;

describe("clampDeltaMs", () => {
	test("caps at 80, floors at 1, falls back on garbage", () => {
		expect(clampDeltaMs(500)).toBe(80);
		expect(clampDeltaMs(0.2)).toBe(1);
		expect(clampDeltaMs(Number.NaN)).toBeCloseTo(FRAME_MS);
		expect(clampDeltaMs(-5)).toBeCloseTo(FRAME_MS);
		expect(clampDeltaMs(33)).toBe(33);
	});
});

describe("stepSpringValue", () => {
	test("first step initializes by snapping to target", () => {
		const state = createSpringState(0);
		const v = stepSpringValue(state, 2, FRAME_MS, getZoomSpringConfig());
		expect(v).toBe(2);
		expect(state.velocity).toBe(0);
	});

	test("converges to a constant target and rests there", () => {
		const state = createSpringState(0);
		stepSpringValue(state, 1, FRAME_MS, getZoomSpringConfig()); // init at 1
		let value = 1;
		for (let i = 0; i < 300; i++) {
			value = stepSpringValue(state, 2, FRAME_MS, getZoomSpringConfig());
		}
		expect(value).toBe(2);
		expect(state.velocity).toBe(0);
	});

	test("moves smoothly: intermediate values strictly between start and target", () => {
		const state = createSpringState(0);
		stepSpringValue(state, 1, FRAME_MS, getZoomSpringConfig());
		const first = stepSpringValue(state, 2, FRAME_MS, getZoomSpringConfig());
		expect(first).toBeGreaterThan(1);
		expect(first).toBeLessThan(2);
	});
});

describe("stepZoomSpring", () => {
	test("crossing the target snaps and zeros velocity (no jelly-wobble)", () => {
		const state = createZoomSpringState();
		resetZoomSpring(state, { scale: 1, x: 0, y: 0 });
		// build velocity toward 2...
		for (let i = 0; i < 6; i++) {
			stepZoomSpring(state, { scale: 2, x: 0, y: 0 }, FRAME_MS);
		}
		// ...then reverse the target below the current value: once a step crosses
		// it, the axis must sit exactly on the target with zero velocity
		let crossedClean = false;
		for (let i = 0; i < 60; i++) {
			const out = stepZoomSpring(state, { scale: 1.2, x: 0, y: 0 }, FRAME_MS);
			if (out.scale === 1.2 && state.scale.velocity === 0) {
				crossedClean = true;
				break;
			}
		}
		expect(crossedClean).toBe(true);
	});

	test("velocity-continuous through a ramp-to-hold kink", () => {
		const state = createZoomSpringState();
		resetZoomSpring(state, { scale: 1, x: 0, y: 0 });
		const outputs: number[] = [];
		// target ramps linearly 1 -> 2 over 30 frames, then holds at 2
		for (let frame = 1; frame <= 60; frame++) {
			const t = Math.min(1, frame / 30);
			const out = stepZoomSpring(state, { scale: 1 + t, x: 0, y: 0 }, FRAME_MS);
			outputs.push(out.scale);
		}
		// after the hold begins the sprung value keeps approaching 2 without
		// overshooting past it (crossing clamp) and without reversing direction
		const tail = outputs.slice(30);
		for (let i = 1; i < tail.length; i++) {
			expect(tail[i]).toBeGreaterThanOrEqual(tail[i - 1] - 1e-9);
			expect(tail[i]).toBeLessThanOrEqual(2 + 1e-9);
		}
		expect(tail[tail.length - 1]).toBeCloseTo(2, 3);
	});

	test("isZoomSpringAtRest true only when parked on target", () => {
		const state = createZoomSpringState();
		resetZoomSpring(state, { scale: 1.5, x: 10, y: 20 });
		expect(isZoomSpringAtRest(state, { scale: 1.5, x: 10, y: 20 })).toBe(true);
		expect(isZoomSpringAtRest(state, { scale: 1, x: 0, y: 0 })).toBe(false);
	});
});
