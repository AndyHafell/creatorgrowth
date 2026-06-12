import type { MagicKind, MagicPlanClip } from "./types";

// Objective "not overwhelming" numbers for a shot list. Pure — the offline
// eval harness scores these against calm-pacing targets (long resting holds,
// zooms only on strong beats, room to breathe at full frame).

export interface PacingStats {
	clipCount: number;
	clipsPerMin: number;
	meanHoldSec: number;
	kindCounts: Record<MagicKind, number>;
	maxConsecutiveZooms: number;
	coveragePct: number;
	/** Share of covered time spent at scale 1 (full frame, breathing room). */
	fullFrameTimePct: number;
	/** Share of clips shorter than 3s. */
	shortHoldPct: number;
}

export function pacingStats({
	clips,
	scopeStart,
	scopeEnd,
}: {
	clips: MagicPlanClip[];
	scopeStart: number;
	scopeEnd: number;
}): PacingStats {
	const span = Math.max(scopeEnd - scopeStart, 0);
	const kindCounts: Record<MagicKind, number> = {
		reframe: 0,
		zoom: 0,
		highlight: 0,
	};
	let coveredSec = 0;
	let fullFrameSec = 0;
	let shortHolds = 0;
	let maxRun = 0;
	let run = 0;
	for (const clip of clips) {
		const len = Math.max(clip.end - clip.start, 0);
		kindCounts[clip.kind] += 1;
		coveredSec += len;
		if (clip.scale <= 1) fullFrameSec += len;
		if (len < 3) shortHolds += 1;
		if (clip.kind === "zoom" || clip.kind === "highlight") {
			run += 1;
			maxRun = Math.max(maxRun, run);
		} else {
			run = 0;
		}
	}
	const count = clips.length;
	return {
		clipCount: count,
		clipsPerMin: span > 0 ? count / (span / 60) : 0,
		meanHoldSec: count > 0 ? coveredSec / count : 0,
		kindCounts,
		maxConsecutiveZooms: maxRun,
		coveragePct: span > 0 ? (coveredSec / span) * 100 : 0,
		fullFrameTimePct: coveredSec > 0 ? (fullFrameSec / coveredSec) * 100 : 0,
		shortHoldPct: count > 0 ? (shortHolds / count) * 100 : 0,
	};
}
