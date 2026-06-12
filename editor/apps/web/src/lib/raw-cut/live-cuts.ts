// Live cut pipeline — the protocol between an external editor agent (Claude
// Code in a terminal) and a running Raw Cut session. The agent pushes commands
// to /api/final-pass/live-cuts; the browser polls the channel and applies them
// here. All times are MEDIA seconds (the transcript timebase the agent reads);
// the surface converts to buffer time when applying.
//
// Red-or-nothing applies here too: a pushed cut IS the decision — it lands on
// the timeline directly, and Andy course-corrects by telling the agent
// ("make that cut 15 seconds") rather than riding a review queue.

import type { ImportedCut } from "@/lib/raw-cut/ai-cut";

export interface LiveSpan {
	start: number;
	end: number;
}

export type LiveCommand =
	| { action: "set"; cuts: ImportedCut[] }
	| { action: "add"; cuts: ImportedCut[] }
	| { action: "adjust"; at: number; start: number; end: number }
	| { action: "remove"; at: number }
	| { action: "clear" }
	// Trigger the in-app AI pass (Scribe + chunked Gemini, browser keys) — lets
	// the agent run the whole cut without Andy clicking anything.
	| { action: "run-ai-cut"; force?: boolean };

/** How far outside a range `at` may land and still grab it (sec). */
const GRAB_TOLERANCE_SEC = 1;

function isFiniteNum(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

function parseCutList(raw: unknown): ImportedCut[] | null {
	if (!Array.isArray(raw)) return null;
	const cuts: ImportedCut[] = [];
	for (const c of raw as Array<Record<string, unknown>>) {
		if (!isFiniteNum(c?.start) || !isFiniteNum(c?.end)) continue;
		if (!(c.end > c.start)) continue;
		cuts.push({
			start: c.start,
			end: c.end,
			reason: String(c.reason ?? ""),
			kind: "fluff",
			confidence: isFiniteNum(c.confidence)
				? Math.max(0, Math.min(1, c.confidence))
				: 1,
			text: typeof c.text === "string" ? c.text : undefined,
			...(typeof c.kind === "string"
				? { kind: c.kind as ImportedCut["kind"] }
				: {}),
		});
	}
	return cuts;
}

/** Validate an untrusted payload into a LiveCommand, or null. */
export function parseLiveCommand(raw: unknown): LiveCommand | null {
	if (typeof raw !== "object" || raw === null) return null;
	const cmd = raw as Record<string, unknown>;
	switch (cmd.action) {
		case "set":
		case "add": {
			const cuts = parseCutList(cmd.cuts);
			if (!cuts) return null;
			return { action: cmd.action, cuts };
		}
		case "adjust": {
			if (
				!isFiniteNum(cmd.at) ||
				!isFiniteNum(cmd.start) ||
				!isFiniteNum(cmd.end) ||
				!(cmd.end > cmd.start)
			) {
				return null;
			}
			return { action: "adjust", at: cmd.at, start: cmd.start, end: cmd.end };
		}
		case "remove":
			return isFiniteNum(cmd.at) ? { action: "remove", at: cmd.at } : null;
		case "clear":
			return { action: "clear" };
		case "run-ai-cut":
			return { action: "run-ai-cut", force: cmd.force === true };
		default:
			return null;
	}
}

function mergeSpans(spans: LiveSpan[]): LiveSpan[] {
	if (spans.length === 0) return [];
	const sorted = [...spans].sort((a, b) => a.start - b.start);
	const out: LiveSpan[] = [{ ...sorted[0] }];
	for (let i = 1; i < sorted.length; i++) {
		const last = out[out.length - 1];
		const cur = sorted[i];
		if (cur.start <= last.end) {
			last.end = Math.max(last.end, cur.end);
		} else {
			out.push({ ...cur });
		}
	}
	return out;
}

function rangeAt(spans: LiveSpan[], at: number): LiveSpan | undefined {
	return spans.find(
		(s) =>
			at >= s.start - GRAB_TOLERANCE_SEC && at <= s.end + GRAB_TOLERANCE_SEC,
	);
}

/**
 * Apply a live command to the current applied-cut list (media seconds).
 * Pure: returns the new list, sorted and overlap-merged.
 */
export function applyLiveCommand(
	current: LiveSpan[],
	cmd: LiveCommand,
): LiveSpan[] {
	switch (cmd.action) {
		case "set":
			return mergeSpans(cmd.cuts.map((c) => ({ start: c.start, end: c.end })));
		case "add":
			return mergeSpans([
				...current,
				...cmd.cuts.map((c) => ({ start: c.start, end: c.end })),
			]);
		case "adjust": {
			const hit = rangeAt(current, cmd.at);
			const rest = hit ? current.filter((s) => s !== hit) : current.slice();
			return mergeSpans([...rest, { start: cmd.start, end: cmd.end }]);
		}
		case "remove": {
			const hit = rangeAt(current, cmd.at);
			return hit ? current.filter((s) => s !== hit) : current.slice();
		}
		case "clear":
			return [];
		// Not a range operation — the surface intercepts it before this point.
		case "run-ai-cut":
			return current.slice();
	}
}
