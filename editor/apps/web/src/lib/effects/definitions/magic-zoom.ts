import {
	type EaseKind,
	type ZoomDirection,
	type ZoomMode,
	zoomEnvelopeProgress,
} from "@/lib/effects/camera";
import type { EffectDefinition } from "@/lib/effects/types";

function num(v: unknown, fallback: number): number {
	const n = typeof v === "number" ? v : Number.parseFloat(String(v));
	return Number.isFinite(n) ? n : fallback;
}

export const magicZoomEffectDefinition: EffectDefinition = {
	type: "magic-zoom",
	name: "Magic Zoom",
	keywords: ["zoom", "magic", "punch", "push", "camera"],
	kind: "camera",
	params: [
		{
			key: "mode",
			label: "Mode",
			type: "select",
			default: "in-out",
			options: [
				{ value: "in-out", label: "In & out" },
				{ value: "continuous", label: "Continuous" },
			],
		},
		{
			key: "scale",
			label: "Zoom",
			type: "number",
			default: 1.8,
			min: 1,
			// 8x is heavily pixelated on 1080p source — but for a number or a
			// small UI element that IS sometimes the shot (Andy hit the old 4
			// cap on a subscriber counter).
			max: 8,
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
		{
			key: "easeIn",
			label: "Ease in (s)",
			type: "number",
			default: 0.5,
			min: 0,
			max: 3,
			step: 0.1,
		},
		{
			key: "easeOut",
			label: "Ease out (s)",
			type: "number",
			default: 0.5,
			min: 0,
			max: 3,
			step: 0.1,
		},
		{
			key: "ease",
			label: "Easing",
			type: "select",
			default: "smooth",
			options: [
				{ value: "smooth", label: "Smooth" },
				{ value: "snappy", label: "Snappy" },
				{ value: "linear", label: "Linear" },
			],
		},
		{
			key: "direction",
			label: "Direction (continuous)",
			type: "select",
			default: "in",
			options: [
				{ value: "in", label: "Zoom in" },
				{ value: "out", label: "Zoom out" },
			],
		},
	],
	renderer: { passes: [] },
	resolveCamera: ({ effectParams, localTime, duration, ticksPerSecond }) => {
		const progress = zoomEnvelopeProgress({
			mode: (effectParams.mode as ZoomMode) ?? "in-out",
			direction: (effectParams.direction as ZoomDirection) ?? "in",
			easeInTicks: num(effectParams.easeIn, 0.5) * ticksPerSecond,
			easeOutTicks: num(effectParams.easeOut, 0.5) * ticksPerSecond,
			durationTicks: duration,
			localTime,
			ease: (effectParams.ease as EaseKind) ?? "smooth",
		});
		const targetScale = num(effectParams.scale, 1.8);
		if (progress < 1e-4 || Math.abs(targetScale - 1) < 1e-4) return null;
		return {
			scale: targetScale,
			focalX: num(effectParams.focalX, 50) / 100,
			focalY: num(effectParams.focalY, 50) / 100,
			progress,
		};
	},
};
