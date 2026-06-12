import type {
	BeatCandidate,
	MagicElementSpec,
	MagicPlan,
	MagicPlanClip,
} from "./types";

// Density / overlap rules: candidates → final non-overlapping plan. The
// hyperedit spec's overlap rule is "last on top wins" at render, but
// overlapping camera clips are confusing to review, so the plan never emits
// them (handoff constraint).

export interface PlanOptions {
	candidates: BeatCandidate[];
	durationSec: number;
	zoomClipSec?: number;
	highlightClipSec?: number;
	minClipSec?: number;
	minGapSec?: number;
	clusterSec?: number;
	leadInSec?: number;
	maxClips?: number;
}

const DEFAULT_ZOOM_SCALE = 1.8;

function defaultMaxClips(durationSec: number): number {
	return Math.max(6, Math.min(36, Math.round(durationSec / 25)));
}

function buildClip({
	cand,
	durationSec,
	zoomClipSec,
	highlightClipSec,
	leadInSec,
}: {
	cand: BeatCandidate;
	durationSec: number;
	zoomClipSec: number;
	highlightClipSec: number;
	leadInSec: number;
}): MagicPlanClip {
	const clipLen = cand.kind === "zoom" ? zoomClipSec : highlightClipSec;
	const start = Math.max(0, cand.triggerStart - leadInSec);
	const end = Math.min(durationSec, start + clipLen);
	const focalX = cand.focalHint?.x ?? 50;
	const focalY = cand.focalHint?.y ?? 50;
	return {
		kind: cand.kind,
		start,
		end,
		scale: cand.kind === "zoom" ? DEFAULT_ZOOM_SCALE : 1,
		focalX,
		focalY,
		...(cand.kind === "highlight"
			? {
					region: {
						x: Math.max(0, Math.min(60, focalX - 20)),
						y: Math.max(0, Math.min(60, focalY - 15)),
						w: 40,
						h: 30,
					},
				}
			: {}),
		easeIn: 0.5,
		easeOut: 0.5,
		reason: cand.reason,
	};
}

export function candidatesToPlan({
	candidates,
	durationSec,
	zoomClipSec = 5,
	highlightClipSec = 4,
	minClipSec = 2,
	minGapSec = 0.75,
	clusterSec = 4,
	leadInSec = 0.35,
	maxClips = defaultMaxClips(durationSec),
}: PlanOptions): MagicPlan {
	const sorted = [...candidates].sort(
		(a, b) => a.triggerStart - b.triggerStart,
	);

	// 1. Cluster nearby candidates, keeping the strongest (ties → earliest).
	const picked: BeatCandidate[] = [];
	for (const cand of sorted) {
		const last = picked[picked.length - 1];
		if (last && cand.triggerStart - last.triggerStart < clusterSec) {
			if (cand.strength > last.strength) picked[picked.length - 1] = cand;
			continue;
		}
		picked.push(cand);
	}

	// 2. Cap density — keep the strongest beats, then re-sort by time.
	const capped =
		picked.length > maxClips
			? [...picked]
					.sort(
						(a, b) =>
							b.strength - a.strength || a.triggerStart - b.triggerStart,
					)
					.slice(0, maxClips)
					.sort((a, b) => a.triggerStart - b.triggerStart)
			: picked;

	// 3. Build clips and resolve collisions: truncate the earlier clip when it
	//    stays a sane length, otherwise drop the later candidate.
	const clips: MagicPlanClip[] = [];
	for (const cand of capped) {
		const clip = buildClip({
			cand,
			durationSec,
			zoomClipSec,
			highlightClipSec,
			leadInSec,
		});
		if (clip.end - clip.start < minClipSec) continue;
		const prev = clips[clips.length - 1];
		if (prev && clip.start < prev.end + minGapSec) {
			const truncatedEnd = clip.start - minGapSec;
			if (truncatedEnd - prev.start >= minClipSec) {
				prev.end = truncatedEnd;
			} else {
				continue;
			}
		}
		clips.push(clip);
	}

	return { clips };
}

/** Plan clip → ticks + EffectElement param overrides. Pure (tps passed in). */
export function planClipToElementSpec({
	clip,
	ticksPerSecond,
}: {
	clip: MagicPlanClip;
	ticksPerSecond: number;
}): MagicElementSpec {
	const lenSec = clip.end - clip.start;
	// Eases must fit inside the clip with room for the hold.
	const easeBudget = lenSec * 0.8;
	let easeIn = clip.easeIn;
	let easeOut = clip.easeOut;
	const easeSum = easeIn + easeOut;
	if (easeSum > easeBudget && easeSum > 0) {
		const k = easeBudget / easeSum;
		easeIn *= k;
		easeOut *= k;
	}

	const startTime = Math.round(clip.start * ticksPerSecond);
	const duration = Math.max(1, Math.round(lenSec * ticksPerSecond));
	const label =
		clip.reason.length > 70 ? `${clip.reason.slice(0, 67)}…` : clip.reason;

	if (clip.kind === "reframe") {
		// Locked framing — magic-reframe has no envelope, just the camera state.
		return {
			effectType: "magic-reframe",
			startTime,
			duration,
			params: {
				scale: clip.scale,
				focalX: clip.focalX,
				focalY: clip.focalY,
			},
			name: `Magic: ${label}`,
		};
	}

	if (clip.kind === "highlight") {
		const region = clip.region ?? { x: 30, y: 35, w: 40, h: 30 };
		return {
			effectType: "magic-highlight",
			startTime,
			duration,
			params: {
				regionX: region.x,
				regionY: region.y,
				regionW: region.w,
				regionH: region.h,
				transition: Math.min(0.5, lenSec / 4),
			},
			name: `Magic: ${label}`,
		};
	}

	return {
		effectType: "magic-zoom",
		startTime,
		duration,
		params: {
			mode: "in-out",
			scale: clip.scale,
			focalX: clip.focalX,
			focalY: clip.focalY,
			easeIn,
			easeOut,
		},
		name: `Magic: ${label}`,
	};
}
