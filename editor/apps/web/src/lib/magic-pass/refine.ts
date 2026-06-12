import { buildDirectorPrompt } from "./director-prompt";
import { estimateSpendUsd, parseRefinedPlan } from "./gemini-parse";
import {
	MAX_REFINE_FRAMES,
	type MagicPlan,
	type MagicPlanClip,
} from "./types";

// Server-side Gemini vision DIRECTOR for the Magic AutoPass shot list (v2).
// v1 asked Gemini to refine heuristic candidates; v2 hands it the timestamped
// transcript + frames sampled across the scope and asks for the full shot
// list — continuous camera direction where every second has an active state.
// Same posture as lib/motion/judge.ts: hard spend ceiling, defensive parse,
// and the heuristic shot list is always the fallback — a director failure
// must never block the effect track from being laid out.

const GEMINI_MODEL = "gemini-3.5-flash";

// Per-process cumulative ceiling (resets on container restart, like judge.ts
// session spend). BYO member keys pay for the call; this is a runaway guard.
const BUDGET_CAP_USD = Number.parseFloat(
	process.env.MAGIC_PASS_BUDGET_USD || "2",
);
let cumulativeSpendUsd = 0;

export interface RefineFrame {
	/** Timeline seconds the frame was sampled at. */
	timeSec: number;
	/** data:image/jpeg;base64,... */
	dataUrl: string;
}

function frameToInlineData(
	frame: RefineFrame,
): { mimeType: string; data: string } | null {
	const m = frame.dataUrl.match(
		/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/,
	);
	if (!m) return null;
	return { mimeType: m[1], data: m[2] };
}

export interface RefineResult {
	plan: MagicPlan;
	refined: boolean;
	spendUsd: number;
	note?: string;
}

export async function directShotList({
	fallback,
	transcriptLines,
	scopeStart,
	scopeEnd,
	frames,
	apiKey,
	previousClip = null,
	cursorHints,
}: {
	fallback: MagicPlan;
	transcriptLines: string[];
	scopeStart: number;
	scopeEnd: number;
	frames: RefineFrame[];
	apiKey: string;
	previousClip?: MagicPlanClip | null;
	/** Recorded mouse dwell hints (v4) — absent/empty keeps the v3 prompt. */
	cursorHints?: string[];
}): Promise<RefineResult> {
	if (cumulativeSpendUsd >= BUDGET_CAP_USD) {
		return {
			plan: fallback,
			refined: false,
			spendUsd: 0,
			note: `budget exhausted ($${cumulativeSpendUsd.toFixed(2)} >= $${BUDGET_CAP_USD})`,
		};
	}

	const parts: Array<
		{ text: string } | { inlineData: { mimeType: string; data: string } }
	> = [
		{
			text: buildDirectorPrompt({
				fallback,
				transcriptLines,
				scopeStart,
				scopeEnd,
				previousClip,
				cursorHints,
			}),
		},
	];
	for (const frame of frames.slice(0, MAX_REFINE_FRAMES)) {
		const inline = frameToInlineData(frame);
		if (!inline) continue;
		parts.push({ text: `Frame at t=${frame.timeSec.toFixed(1)}s:` });
		parts.push({ inlineData: inline });
	}

	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
	const resp = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			contents: [{ role: "user", parts }],
			generationConfig: {
				temperature: 0.2,
				responseMimeType: "application/json",
				// Full-video shot lists run long; don't let the default cap
				// truncate the JSON mid-array.
				maxOutputTokens: 32768,
			},
		}),
	});
	if (!resp.ok) {
		const errText = await resp.text();
		return {
			plan: fallback,
			refined: false,
			spendUsd: 0,
			note: `Gemini HTTP ${resp.status}: ${errText.slice(0, 200)}`,
		};
	}

	const json = (await resp.json()) as {
		candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
		usageMetadata?: {
			promptTokenCount?: number;
			candidatesTokenCount?: number;
		};
	};
	const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
	const spendUsd = estimateSpendUsd({
		promptTokens: json.usageMetadata?.promptTokenCount ?? 0,
		outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
	});
	cumulativeSpendUsd += spendUsd;

	const directed = parseRefinedPlan({ text, fallback });
	const refined = directed !== fallback;
	return {
		plan: directed,
		refined,
		spendUsd,
		...(refined ? {} : { note: "parse fallback — heuristic shot list kept" }),
	};
}
