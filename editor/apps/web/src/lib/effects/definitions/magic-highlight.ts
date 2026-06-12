import { inOutEnvelope } from "@/lib/effects/camera";
import type { EffectDefinition } from "@/lib/effects/types";

function num(v: unknown, fallback: number): number {
	const n = typeof v === "number" ? v : Number.parseFloat(String(v));
	return Number.isFinite(n) ? n : fallback;
}

export const magicHighlightEffectDefinition: EffectDefinition = {
	type: "magic-highlight",
	name: "Magic Highlighter",
	keywords: ["highlight", "magic", "spotlight", "cutout", "focus"],
	kind: "highlight",
	params: [
		{
			key: "regionX",
			label: "Region X",
			type: "number",
			default: 25,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "regionY",
			label: "Region Y",
			type: "number",
			default: 25,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "regionW",
			label: "Region width",
			type: "number",
			default: 50,
			min: 2,
			max: 100,
			step: 1,
		},
		{
			key: "regionH",
			label: "Region height",
			type: "number",
			default: 50,
			min: 2,
			max: 100,
			step: 1,
		},
		{
			key: "size",
			label: "Pop size",
			type: "number",
			default: 65,
			min: 20,
			max: 100,
			step: 1,
		},
		{
			key: "transition",
			label: "Transition (s)",
			type: "number",
			default: 0.5,
			min: 0,
			max: 2,
			step: 0.05,
		},
		{
			key: "dim",
			label: "Background dim",
			type: "number",
			default: 70,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "blur",
			label: "Background blur",
			type: "number",
			default: 25,
			min: 0,
			max: 100,
			step: 1,
		},
		{
			key: "cornerRadius",
			label: "Corner radius",
			type: "number",
			default: 12,
			min: 0,
			max: 48,
			step: 1,
		},
	],
	renderer: { passes: [] },
	resolveHighlight: ({ effectParams, localTime, duration, ticksPerSecond }) => {
		const progress = inOutEnvelope({
			localTime,
			rampTicks: num(effectParams.transition, 0.5) * ticksPerSecond,
			durationTicks: duration,
			ease: "smooth",
		});
		return {
			region: {
				x: num(effectParams.regionX, 25) / 100,
				y: num(effectParams.regionY, 25) / 100,
				w: num(effectParams.regionW, 50) / 100,
				h: num(effectParams.regionH, 50) / 100,
			},
			size: num(effectParams.size, 65) / 100,
			progress,
			dim: num(effectParams.dim, 70) / 100,
			blurIntensity: num(effectParams.blur, 25),
			cornerRadius: num(effectParams.cornerRadius, 12),
		};
	},
};
