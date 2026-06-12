import type { BeatCandidate } from "./types";
import {
	mediaSecToTimelineSec,
	type ElementWindow,
} from "./timeline-map";

// Cursor-driven zoom targeting (Magic AutoPass v4). Dwell detection adapted
// from OpenScreen (MIT, github.com/siddharthvaddem/openscreen) —
// src/components/video-editor/timeline/zoomSuggestionUtils.ts: a cursor
// staying within a small radius for 450-2600ms marks a moment worth a punch-in
// at the averaged position; longer dwells rank stronger, accepted dwells keep
// 1.8s spacing. Extended here with click/clickable enrichment from the sidecar
// log so deliberate dwells (a click, hovering a button) outrank idle ones.
// Pure — all sample times are MEDIA milliseconds; cursorBeatCandidates maps
// them through cuts onto the timeline. No opencut-wasm imports, bun-testable.

export const MIN_DWELL_DURATION_MS = 450;
export const MAX_DWELL_DURATION_MS = 2600;
export const DWELL_MOVE_THRESHOLD = 0.02;
/** Minimum spacing between two accepted dwell centres. */
export const DWELL_SPACING_MS = 1800;

/** One sidecar sample — media-time ms, position normalized 0-1. */
export interface CursorSample {
	timeMs: number;
	cx: number;
	cy: number;
	/** A left-click landed in this sample window. */
	leftButtonPressed?: boolean;
	/** AX classification of the element under the cursor. */
	cursorType?: "pointer" | "text" | null;
}

export interface CursorDwell {
	centerTimeMs: number;
	startTimeMs: number;
	endTimeMs: number;
	/** Averaged position over the run, normalized 0-1. */
	cx: number;
	cy: number;
	/** Run duration — the dwell's ranking strength. */
	durationMs: number;
	hasClick: boolean;
	overClickable: boolean;
}

function clamp01(v: number): number {
	return Math.max(0, Math.min(v, 1));
}

/**
 * Parse a sidecar NDJSON log into clean samples: header/ready lines skipped,
 * malformed lines dropped, cx/cy clamped, sorted by time. Lines carrying only
 * an epoch timestampMs (the raw OpenScreen helper format) get a relative
 * timeMs derived from the header's startEpochMs.
 */
export function parseCursorLog(ndjson: string): CursorSample[] {
	let startEpochMs: number | null = null;
	const out: CursorSample[] = [];
	for (const line of ndjson.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let row: Record<string, unknown>;
		try {
			row = JSON.parse(trimmed) as Record<string, unknown>;
		} catch {
			continue;
		}
		if (row.type === "header" && typeof row.startEpochMs === "number") {
			startEpochMs = row.startEpochMs;
			continue;
		}
		if (row.type !== undefined && row.type !== "sample") continue;
		let timeMs = typeof row.timeMs === "number" ? row.timeMs : null;
		if (
			timeMs === null &&
			typeof row.timestampMs === "number" &&
			startEpochMs !== null
		) {
			timeMs = row.timestampMs - startEpochMs;
		}
		if (
			timeMs === null ||
			!Number.isFinite(timeMs) ||
			typeof row.cx !== "number" ||
			typeof row.cy !== "number" ||
			!Number.isFinite(row.cx) ||
			!Number.isFinite(row.cy)
		) {
			continue;
		}
		out.push({
			timeMs,
			cx: clamp01(row.cx),
			cy: clamp01(row.cy),
			leftButtonPressed: row.leftButtonPressed === true,
			cursorType:
				row.cursorType === "pointer" || row.cursorType === "text"
					? row.cursorType
					: null,
		});
	}
	return out.sort((a, b) => a.timeMs - b.timeMs);
}

/**
 * Dwell runs: consecutive samples whose step distance stays within
 * DWELL_MOVE_THRESHOLD, lasting MIN..MAX dwell duration. Position is the run
 * average; click/clickable flags are true if any sample in the run carries
 * them. (Runs past MAX are a parked mouse, not attention.)
 */
export function detectCursorDwells(samples: CursorSample[]): CursorDwell[] {
	if (samples.length < 2) return [];

	const dwells: CursorDwell[] = [];
	let runStart = 0;

	const pushRunIfDwell = (startIndex: number, endIndexExclusive: number) => {
		if (endIndexExclusive - startIndex < 2) return;
		const start = samples[startIndex];
		const end = samples[endIndexExclusive - 1];
		const runDuration = end.timeMs - start.timeMs;
		if (
			runDuration < MIN_DWELL_DURATION_MS ||
			runDuration > MAX_DWELL_DURATION_MS
		) {
			return;
		}
		const run = samples.slice(startIndex, endIndexExclusive);
		dwells.push({
			centerTimeMs: Math.round((start.timeMs + end.timeMs) / 2),
			startTimeMs: start.timeMs,
			endTimeMs: end.timeMs,
			cx: run.reduce((sum, s) => sum + s.cx, 0) / run.length,
			cy: run.reduce((sum, s) => sum + s.cy, 0) / run.length,
			durationMs: runDuration,
			hasClick: run.some((s) => s.leftButtonPressed === true),
			overClickable: run.some((s) => s.cursorType === "pointer"),
		});
	};

	for (let i = 1; i < samples.length; i++) {
		const prev = samples[i - 1];
		const curr = samples[i];
		const distance = Math.hypot(curr.cx - prev.cx, curr.cy - prev.cy);
		if (distance > DWELL_MOVE_THRESHOLD) {
			pushRunIfDwell(runStart, i);
			runStart = i;
		}
	}
	pushRunIfDwell(runStart, samples.length);

	return dwells;
}

/**
 * Strongest-first selection with minimum spacing between accepted centres,
 * returned in time order. (Overlap against the rest of the shot list is the
 * planner's job — buildShotList clusters and resolves collisions.)
 */
export function rankAndSpaceDwells(
	dwells: CursorDwell[],
	{ spacingMs = DWELL_SPACING_MS }: { spacingMs?: number } = {},
): CursorDwell[] {
	const ranked = [...dwells].sort((a, b) => b.durationMs - a.durationMs);
	const accepted: CursorDwell[] = [];
	for (const dwell of ranked) {
		const tooClose = accepted.some(
			(d) => Math.abs(d.centerTimeMs - dwell.centerTimeMs) < spacingMs,
		);
		if (!tooClose) accepted.push(dwell);
	}
	return accepted.sort((a, b) => a.centerTimeMs - b.centerTimeMs);
}

/**
 * Dwells (media time) → zoom BeatCandidates (timeline time). Dwells whose
 * centre falls in cut content are dropped. Strength 2 when the dwell contains
 * a click or sits over a clickable (deliberate attention), else 1 — the
 * transcript/director pacing rules still gate which dwells become zooms.
 */
export function cursorBeatCandidates({
	dwells,
	elements,
	ticksPerSecond,
}: {
	dwells: CursorDwell[];
	elements: ElementWindow[];
	ticksPerSecond: number;
}): BeatCandidate[] {
	const out: BeatCandidate[] = [];
	for (const dwell of dwells) {
		const center = mediaSecToTimelineSec({
			mediaSec: dwell.centerTimeMs / 1000,
			elements,
			ticksPerSecond,
		});
		if (center === null) continue;
		const halfSec = dwell.durationMs / 2000;
		const what = dwell.hasClick
			? "click"
			: dwell.overClickable
				? "hover on clickable"
				: "dwell";
		out.push({
			kind: "zoom",
			triggerStart: Math.max(0, center - halfSec),
			triggerEnd: center + halfSec,
			reason: `cursor ${what} (${(dwell.durationMs / 1000).toFixed(1)}s still)`,
			focalHint: { x: dwell.cx * 100, y: dwell.cy * 100 },
			strength: dwell.hasClick || dwell.overClickable ? 2 : 1,
		});
	}
	return out;
}

/**
 * Cursor candidates inside [scopeStart, scopeEnd) → director-prompt hint
 * lines with exact focals. Empty when no cursor log is attached, which keeps
 * the v3 prompt byte-identical.
 */
export function cursorHintLines({
	candidates,
	scopeStart,
	scopeEnd,
}: {
	candidates: BeatCandidate[];
	scopeStart: number;
	scopeEnd: number;
}): string[] {
	return candidates
		.filter((c) => c.triggerStart >= scopeStart && c.triggerStart < scopeEnd)
		.map((c) => {
			const focal = c.focalHint
				? `(${Math.round(c.focalHint.x)}, ${Math.round(c.focalHint.y)})`
				: "(50, 50)";
			const marker = c.strength >= 2 ? " [clicked/clickable]" : "";
			return `- ${c.triggerStart.toFixed(1)}–${c.triggerEnd.toFixed(1)}s cursor dwelled at ${focal}%${marker}`;
		});
}
