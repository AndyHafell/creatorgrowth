import type { MagicPlanClip } from "./types";

// v3 chunked direction: a full-video scope is too long for one director call
// (32 frames over 13 min ≈ one frame per 24s — too coarse to direct from).
// The scope is split into ~2-minute windows that each get full frame density,
// directed sequentially, then stitched. Pure — timeline seconds only, no
// opencut-wasm imports, bun-testable.

export interface ScopeChunk {
	start: number;
	end: number;
}

/**
 * Split [scopeStart, scopeEnd] into contiguous chunks of roughly
 * targetChunkSec, snapping interior cuts to a nearby natural boundary
 * (silence gap / sentence end) when one is close enough. Chunk count is
 * capped — very long scopes widen the chunks instead.
 */
export function splitScopeIntoChunks({
	scopeStart,
	scopeEnd,
	targetChunkSec = 135,
	boundaries = [],
	snapToleranceSec = 20,
	maxChunks = 16,
}: {
	scopeStart: number;
	scopeEnd: number;
	targetChunkSec?: number;
	boundaries?: number[];
	snapToleranceSec?: number;
	maxChunks?: number;
}): ScopeChunk[] {
	const span = scopeEnd - scopeStart;
	if (span <= 0) return [];
	const count = Math.min(maxChunks, Math.max(1, Math.ceil(span / targetChunkSec)));
	const step = span / count;
	const cuts: number[] = [];
	for (let i = 1; i < count; i++) {
		const even = scopeStart + i * step;
		const prev = cuts[cuts.length - 1] ?? scopeStart;
		const snapped = boundaries
			.filter(
				(b) =>
					Math.abs(b - even) <= snapToleranceSec &&
					b > prev + step / 2 &&
					b < scopeEnd - step / 2,
			)
			.sort((a, b) => Math.abs(a - even) - Math.abs(b - even))[0];
		cuts.push(snapped ?? even);
	}
	const edges = [scopeStart, ...cuts, scopeEnd];
	const out: ScopeChunk[] = [];
	for (let i = 0; i < edges.length - 1; i++) {
		out.push({ start: edges[i], end: edges[i + 1] });
	}
	return out;
}

/**
 * Merge runs of contiguous reframe clips whose framing is (near-)identical
 * into one long hold. Calms the pacing and removes invisible "cuts" at chunk
 * seams when the director kept the previous framing. Zoom/highlight clips
 * are deliberate beats and never merge.
 */
export function mergeAdjacentReframes(
	clips: MagicPlanClip[],
	{ scaleEps = 0.06, focalEps = 3, gapEps = 0.05 }: {
		scaleEps?: number;
		focalEps?: number;
		gapEps?: number;
	} = {},
): MagicPlanClip[] {
	const out: MagicPlanClip[] = [];
	for (const clip of clips) {
		const prev = out[out.length - 1];
		if (
			prev &&
			prev.kind === "reframe" &&
			clip.kind === "reframe" &&
			Math.abs(clip.start - prev.end) <= gapEps &&
			Math.abs(clip.scale - prev.scale) <= scaleEps &&
			Math.abs(clip.focalX - prev.focalX) <= focalEps &&
			Math.abs(clip.focalY - prev.focalY) <= focalEps
		) {
			prev.end = clip.end;
			continue;
		}
		out.push({ ...clip });
	}
	return out;
}
