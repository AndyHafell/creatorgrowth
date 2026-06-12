import type { EffectDefinition } from "@/lib/effects/types";

function num(v: unknown, fallback: number): number {
	const n = typeof v === "number" ? v : Number.parseFloat(String(v));
	return Number.isFinite(n) ? n : fallback;
}

/**
 * Magic Reframe — Andy's "state 1": a locked framing held for the whole clip.
 * No envelope, no easing — "boom, it's in the right screen format". The
 * preview overlay offers one-click presets (halves/thirds) that just write
 * these params; render-side it is a constant camera at full progress.
 */
export const magicReframeEffectDefinition: EffectDefinition = {
	type: "magic-reframe",
	name: "Magic Reframe",
	keywords: ["reframe", "magic", "preset", "crop", "frame", "lock"],
	kind: "camera",
	params: [
		{
			key: "scale",
			label: "Zoom",
			type: "number",
			default: 2,
			min: 1,
			max: 4,
			step: 0.05,
		},
		{
			key: "focalX",
			label: "Focus X",
			type: "number",
			default: 50,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "focalY",
			label: "Focus Y",
			type: "number",
			default: 50,
			min: 0,
			max: 100,
			step: 1,
		},
	],
	renderer: { passes: [] },
	resolveCamera: ({ effectParams }) => {
		const targetScale = num(effectParams.scale, 2);
		if (Math.abs(targetScale - 1) < 1e-4) return null;
		return {
			scale: targetScale,
			focalX: num(effectParams.focalX, 50) / 100,
			focalY: num(effectParams.focalY, 50) / 100,
			progress: 1,
		};
	},
};

/** Preset chips shown on the preview overlay when a reframe clip is selected. */
export const MAGIC_REFRAME_PRESETS: Array<{
	label: string;
	scale: number;
	focalX: number;
	focalY: number;
}> = [
	{ label: "L ½", scale: 2, focalX: 25, focalY: 50 },
	{ label: "R ½", scale: 2, focalX: 75, focalY: 50 },
	{ label: "L ⅓", scale: 3, focalX: 17, focalY: 50 },
	{ label: "C ⅓", scale: 3, focalX: 50, focalY: 50 },
	{ label: "R ⅓", scale: 3, focalX: 83, focalY: 50 },
];
