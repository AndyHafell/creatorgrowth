import type { MagicPlan, MagicPlanClip } from "./types";

// Defensive parsing of the Gemini refine response — same posture as
// lib/motion/judge.ts parseJudge: strip fences, find the first {...}, clamp
// every number, drop anything malformed, and fall back to the heuristic plan
// rather than failing the request.

function clamp(v: unknown, min: number, max: number, fallback: number): number {
	const n = typeof v === "number" ? v : Number.parseFloat(String(v));
	if (!Number.isFinite(n)) return fallback;
	return Math.max(min, Math.min(max, n));
}

function parseClip(raw: unknown): MagicPlanClip | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	if (
		obj.kind !== "zoom" &&
		obj.kind !== "highlight" &&
		obj.kind !== "reframe"
	) {
		return null;
	}
	const start = clamp(obj.start, 0, Number.MAX_SAFE_INTEGER, Number.NaN);
	const end = clamp(obj.end, 0, Number.MAX_SAFE_INTEGER, Number.NaN);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
		return null;
	}
	const region =
		typeof obj.region === "object" && obj.region !== null
			? {
					x: clamp((obj.region as Record<string, unknown>).x, 0, 98, 30),
					y: clamp((obj.region as Record<string, unknown>).y, 0, 98, 35),
					w: clamp((obj.region as Record<string, unknown>).w, 2, 100, 40),
					h: clamp((obj.region as Record<string, unknown>).h, 2, 100, 30),
				}
			: undefined;
	return {
		kind: obj.kind,
		start,
		end,
		// Max 3 matches the documented contract (zoom ceiling for tiny
		// targets); anything higher pixelates a 1080p screen recording.
		scale: clamp(obj.scale, 1, 3, 1.8),
		focalX: clamp(obj.focalX, 0, 100, 50),
		focalY: clamp(obj.focalY, 0, 100, 50),
		...(region ? { region } : {}),
		easeIn: clamp(obj.easeIn, 0, 3, 0.5),
		easeOut: clamp(obj.easeOut, 0, 3, 0.5),
		reason: typeof obj.reason === "string" ? obj.reason : "AI pick",
		...(obj.browser === true ? { browser: true } : {}),
	};
}

export function parseRefinedPlan({
	text,
	fallback,
}: {
	text: string;
	fallback: MagicPlan;
}): MagicPlan {
	const cleaned = text
		.replace(/```json/gi, "")
		.replace(/```/g, "")
		.trim();
	const m = cleaned.match(/\{[\s\S]*\}/);
	if (!m) return fallback;
	try {
		const obj = JSON.parse(m[0]) as { clips?: unknown[] };
		if (!Array.isArray(obj.clips)) return fallback;
		const clips = obj.clips
			.map(parseClip)
			.filter((c): c is MagicPlanClip => c !== null)
			.sort((a, b) => a.start - b.start);
		if (clips.length === 0) return fallback;
		return { clips };
	} catch {
		return fallback;
	}
}

// Gemini 2.5 Flash pricing (USD per 1M tokens) — same constants as judge.ts.
const PRICE_INPUT_PER_M = 0.3;
const PRICE_OUTPUT_PER_M = 2.5;

export function estimateSpendUsd({
	promptTokens,
	outputTokens,
}: {
	promptTokens: number;
	outputTokens: number;
}): number {
	return (
		(promptTokens / 1_000_000) * PRICE_INPUT_PER_M +
		(outputTokens / 1_000_000) * PRICE_OUTPUT_PER_M
	);
}
