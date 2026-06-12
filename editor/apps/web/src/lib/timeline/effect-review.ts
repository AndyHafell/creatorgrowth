import type { OverlayTrack } from "./types";

/**
 * Pure helpers for Magic Review — the keyboard-first pass over AI-generated
 * effect-track clips (Magic Zoom / Magic Highlighter). All times are in the
 * caller's unit (ticks everywhere in the editor); nothing here imports wasm so
 * the module stays testable under bun.
 */
export interface ReviewClip {
	trackId: string;
	elementId: string;
	startTime: number;
	endTime: number;
	name: string;
	effectType: string;
}

export function collectEffectClips({
	overlay,
}: {
	overlay: OverlayTrack[];
}): ReviewClip[] {
	const clips: ReviewClip[] = [];
	for (const track of overlay) {
		if (track.type !== "effect") continue;
		for (const element of track.elements) {
			clips.push({
				trackId: track.id,
				elementId: element.id,
				startTime: element.startTime,
				endTime: element.startTime + element.duration,
				name: element.name,
				effectType: element.effectType,
			});
		}
	}
	return clips.sort((a, b) => a.startTime - b.startTime);
}

export function clipIndexAtTime({
	clips,
	time,
}: {
	clips: ReviewClip[];
	time: number;
}): number {
	return clips.findIndex(
		(clip) => time >= clip.startTime && time < clip.endTime,
	);
}

export function nextClipIndex({
	clips,
	time,
}: {
	clips: ReviewClip[];
	time: number;
}): number {
	return clips.findIndex((clip) => clip.startTime > time);
}

/**
 * Mid-clip this rewinds to the clip's own start (music-player prev behavior);
 * sitting exactly on a start it steps to the clip before.
 */
export function prevClipIndex({
	clips,
	time,
}: {
	clips: ReviewClip[];
	time: number;
}): number {
	for (let i = clips.length - 1; i >= 0; i--) {
		if (clips[i].startTime < time) return i;
	}
	return -1;
}

export type MagicKindName = "reframe" | "zoom" | "highlight";

const HIGHLIGHT_REGION_W = 40;
const HIGHLIGHT_REGION_H = 30;
const MIN_ZOOM_SCALE = 1.8;
const DEFAULT_REFRAME_SCALE = 1.3;

function asNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value)
		? value
		: fallback;
}

/**
 * Convert a Magic clip's params to another kind (review-mode 1/2/3 keys).
 * The camera target carries over: zoom/reframe focal ↔ highlight region
 * center. A reframe promoted to zoom tightens to at least the punch-in
 * minimum; a zoom demoted to reframe keeps its framing as the resting state.
 */
export function magicParamsForKind({
	fromEffectType,
	params,
	targetKind,
}: {
	fromEffectType: string;
	params: Record<string, number | string>;
	targetKind: MagicKindName;
}): {
	effectType: `magic-${MagicKindName}`;
	params: Record<string, number | string>;
} {
	const fromHighlight = fromEffectType === "magic-highlight";
	const focalX = fromHighlight
		? asNumber(params.regionX, 30) +
			asNumber(params.regionW, HIGHLIGHT_REGION_W) / 2
		: asNumber(params.focalX, 50);
	const focalY = fromHighlight
		? asNumber(params.regionY, 35) +
			asNumber(params.regionH, HIGHLIGHT_REGION_H) / 2
		: asNumber(params.focalY, 50);
	const scale = fromHighlight
		? MIN_ZOOM_SCALE
		: asNumber(params.scale, DEFAULT_REFRAME_SCALE);

	if (targetKind === "zoom") {
		return {
			effectType: "magic-zoom",
			params: {
				mode: "in-out",
				scale: Math.max(MIN_ZOOM_SCALE, scale),
				focalX,
				focalY,
				easeIn: asNumber(params.easeIn, 0.5),
				easeOut: asNumber(params.easeOut, 0.5),
			},
		};
	}

	if (targetKind === "highlight") {
		return {
			effectType: "magic-highlight",
			params: {
				regionX: Math.max(
					0,
					Math.min(100 - HIGHLIGHT_REGION_W, focalX - HIGHLIGHT_REGION_W / 2),
				),
				regionY: Math.max(
					0,
					Math.min(100 - HIGHLIGHT_REGION_H, focalY - HIGHLIGHT_REGION_H / 2),
				),
				regionW: HIGHLIGHT_REGION_W,
				regionH: HIGHLIGHT_REGION_H,
				transition: asNumber(params.transition, 0.5),
			},
		};
	}

	return {
		effectType: "magic-reframe",
		params: {
			scale,
			focalX,
			focalY,
		},
	};
}

/**
 * Largest portion of `delta` the clip can move without crossing 0 or
 * overlapping a neighbor on its own track.
 */
export function clampNudge({
	clip,
	clips,
	delta,
}: {
	clip: ReviewClip;
	clips: ReviewClip[];
	delta: number;
}): number {
	const neighbors = clips.filter(
		(other) =>
			other.trackId === clip.trackId && other.elementId !== clip.elementId,
	);

	if (delta > 0) {
		let allowed = delta;
		for (const other of neighbors) {
			if (other.startTime >= clip.endTime) {
				allowed = Math.min(allowed, other.startTime - clip.endTime);
			}
		}
		return allowed;
	}

	let allowed = Math.max(delta, -clip.startTime);
	for (const other of neighbors) {
		if (other.endTime <= clip.startTime) {
			allowed = Math.max(allowed, other.endTime - clip.startTime);
		}
	}
	return allowed;
}
