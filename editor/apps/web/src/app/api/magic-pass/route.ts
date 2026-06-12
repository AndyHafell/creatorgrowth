import { NextResponse } from "next/server";
import { directShotList, type RefineFrame } from "@/lib/magic-pass/refine";
import {
	MAX_REFINE_FRAMES,
	type MagicPlan,
	type MagicPlanClip,
} from "@/lib/magic-pass/types";

// Magic AutoPass (v2, Agent 12) — director step. The CLIENT builds the
// heuristic shot list from the Raw Cut transcript (lib/magic-pass — pure,
// shared) and samples frames across the scope window; this route runs the
// Gemini vision DIRECTOR that writes the full shot list from transcript +
// frames, then hands it back. No key or any director failure → the heuristic
// shot list is returned unchanged, so the effect track always gets laid out.
//
// BYO-key model matches the final-pass routes: the member's Gemini key
// arrives per-request via x-gemini-key — never a shared platform key.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_TRANSCRIPT_LINES = 400;
const MAX_LINE_CHARS = 400;
// A 2-min chunk at the 1.8s dwell spacing tops out around 66 dwells.
const MAX_CURSOR_HINTS = 80;

interface MagicPassBody {
	plan?: { clips?: MagicPlanClip[] };
	transcriptLines?: string[];
	scope?: { start?: number; end?: number };
	durationSec?: number;
	frames?: RefineFrame[];
	/** Last clip of the previous chunk — continuity across chunked windows. */
	previousClip?: MagicPlanClip | null;
	/** Recorded mouse dwell hint lines (v4) — absent keeps v3 behavior. */
	cursorHints?: string[];
}

function sanitizePreviousClip(
	clip: MagicPassBody["previousClip"],
): MagicPlanClip | null {
	if (
		!clip ||
		typeof clip.scale !== "number" ||
		typeof clip.focalX !== "number" ||
		typeof clip.focalY !== "number" ||
		typeof clip.start !== "number" ||
		typeof clip.end !== "number"
	) {
		return null;
	}
	return { ...clip, reason: String(clip.reason ?? "").slice(0, 120) };
}

function sanitizePlan(plan: MagicPassBody["plan"]): MagicPlan | null {
	if (!plan || !Array.isArray(plan.clips)) return null;
	return { clips: plan.clips };
}

export async function POST(req: Request) {
	let body: MagicPassBody;
	try {
		body = (await req.json()) as MagicPassBody;
	} catch {
		return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
	}

	const plan = sanitizePlan(body.plan);
	if (!plan) {
		return NextResponse.json(
			{ error: "body.plan.clips required" },
			{ status: 400 },
		);
	}
	const durationSec =
		typeof body.durationSec === "number" && body.durationSec > 0
			? body.durationSec
			: 0;
	const scopeStart =
		typeof body.scope?.start === "number" && body.scope.start >= 0
			? body.scope.start
			: 0;
	const scopeEnd =
		typeof body.scope?.end === "number" && body.scope.end > scopeStart
			? body.scope.end
			: durationSec;
	const transcriptLines = Array.isArray(body.transcriptLines)
		? body.transcriptLines
				.filter((l): l is string => typeof l === "string")
				.slice(0, MAX_TRANSCRIPT_LINES)
				.map((l) => l.slice(0, MAX_LINE_CHARS))
		: [];
	const frames = Array.isArray(body.frames)
		? body.frames
				.filter(
					(f): f is RefineFrame =>
						typeof f?.dataUrl === "string" && typeof f?.timeSec === "number",
				)
				.slice(0, MAX_REFINE_FRAMES)
		: [];
	const cursorHints = Array.isArray(body.cursorHints)
		? body.cursorHints
				.filter((l): l is string => typeof l === "string")
				.slice(0, MAX_CURSOR_HINTS)
				.map((l) => l.slice(0, MAX_LINE_CHARS))
		: [];

	const apiKey = req.headers.get("x-gemini-key")?.trim() || null;
	if (!apiKey || frames.length === 0 || scopeEnd <= scopeStart) {
		return NextResponse.json({
			plan,
			refined: false,
			spendUsd: 0,
			note: !apiKey ? "no Gemini key — heuristic shot list" : "no frames",
		});
	}

	try {
		const result = await directShotList({
			fallback: plan,
			transcriptLines,
			scopeStart,
			scopeEnd,
			frames,
			apiKey,
			previousClip: sanitizePreviousClip(body.previousClip),
			cursorHints,
		});
		return NextResponse.json(result);
	} catch (err) {
		return NextResponse.json({
			plan,
			refined: false,
			spendUsd: 0,
			note: `director failed: ${err instanceof Error ? err.message : String(err)}`,
		});
	}
}
