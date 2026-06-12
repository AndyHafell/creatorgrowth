// Adapted from OpenScreen, MIT, github.com/siddharthvaddem/openscreen
// (src/components/video-editor/videoPlayback/{motionSmoothing,zoomSpring}.ts)
//
// Spring-chase for the Magic camera: the envelope-shaped transform from
// camera.ts stays the authored TARGET; a per-axis spring chases it so the
// rendered motion is velocity-continuous through ease ramps, holds, clip
// seams and reframe cuts — the Screen Studio feel.

import { spring } from "motion";

export interface SpringState {
	value: number;
	velocity: number;
	initialized: boolean;
}

export interface SpringConfig {
	stiffness: number;
	damping: number;
	mass: number;
	restDelta?: number;
	restSpeed?: number;
}

export function createSpringState(initialValue = 0): SpringState {
	return {
		value: initialValue,
		velocity: 0,
		initialized: false,
	};
}

export function clampDeltaMs(deltaMs: number, fallbackMs = 1000 / 60): number {
	if (!Number.isFinite(deltaMs) || deltaMs <= 0) {
		return fallbackMs;
	}
	return Math.min(80, Math.max(1, deltaMs));
}

export function stepSpringValue(
	state: SpringState,
	target: number,
	deltaMs: number,
	config: SpringConfig,
): number {
	const safeDeltaMs = clampDeltaMs(deltaMs);

	if (!state.initialized || !Number.isFinite(state.value)) {
		state.value = target;
		state.velocity = 0;
		state.initialized = true;
		return state.value;
	}

	const restDelta = config.restDelta ?? 0.0005;
	const restSpeed = config.restSpeed ?? 0.02;

	if (
		Math.abs(target - state.value) <= restDelta &&
		Math.abs(state.velocity) <= restSpeed
	) {
		state.value = target;
		state.velocity = 0;
		return state.value;
	}

	const previousValue = state.value;
	const generator = spring({
		keyframes: [state.value, target],
		velocity: state.velocity,
		stiffness: config.stiffness,
		damping: config.damping,
		mass: config.mass,
		restDelta,
		restSpeed,
	});

	const result = generator.next(safeDeltaMs);
	state.value = result.done ? target : result.value;
	state.velocity = ((state.value - previousValue) / safeDeltaMs) * 1000;

	if (result.done) {
		state.velocity = 0;
	}

	return state.value;
}

/** Screen Studio's camera feel constants (OpenScreen call sites). */
export function getZoomSpringConfig(): SpringConfig {
	return {
		stiffness: 320,
		damping: 40,
		mass: 0.92,
		restDelta: 0.0005,
		restSpeed: 0.015,
	};
}

/** Camera transform in window space: scale + crop-window origin (px). */
export interface ZoomTransform {
	scale: number;
	x: number;
	y: number;
}

export interface ZoomSpringState {
	scale: SpringState;
	x: SpringState;
	y: SpringState;
}

export function createZoomSpringState(): ZoomSpringState {
	return {
		scale: createSpringState(1),
		x: createSpringState(0),
		y: createSpringState(0),
	};
}

/** Snap every axis straight to the target (seek / scrub / first frame). */
export function resetZoomSpring(
	state: ZoomSpringState,
	target: ZoomTransform,
): void {
	for (const [axis, value] of [
		[state.scale, target.scale],
		[state.x, target.x],
		[state.y, target.y],
	] as const) {
		axis.value = value;
		axis.velocity = 0;
		axis.initialized = true;
	}
}

/**
 * Step one axis with a moving-target overshoot clamp: if the step crosses the
 * target, snap to it and zero the velocity. Kills jelly-wobble on reversals
 * while staying fast — what makes spring-chase usable on a target that moves
 * every frame.
 */
function stepAxis(
	axis: SpringState,
	target: number,
	deltaMs: number,
	config: SpringConfig,
): number {
	const before = axis.initialized ? axis.value : target;
	const after = stepSpringValue(axis, target, deltaMs, config);
	const crossed =
		(before <= target && after > target) ||
		(before >= target && after < target);
	if (crossed) {
		axis.value = target;
		axis.velocity = 0;
		return target;
	}
	return after;
}

/** Advance the spring toward target by deltaMs (CONTENT time, not wall time). */
export function stepZoomSpring(
	state: ZoomSpringState,
	target: ZoomTransform,
	deltaMs: number,
): ZoomTransform {
	const config = getZoomSpringConfig();
	return {
		scale: stepAxis(state.scale, target.scale, deltaMs, config),
		x: stepAxis(state.x, target.x, deltaMs, config),
		y: stepAxis(state.y, target.y, deltaMs, config),
	};
}

/** True when every axis sits exactly on the target with no velocity. */
export function isZoomSpringAtRest(
	state: ZoomSpringState,
	target: ZoomTransform,
): boolean {
	return (
		state.scale.initialized &&
		state.scale.value === target.scale &&
		state.scale.velocity === 0 &&
		state.x.value === target.x &&
		state.x.velocity === 0 &&
		state.y.value === target.y &&
		state.y.velocity === 0
	);
}
