// Grading for the Raw Cut AI engine against a hand-built reference edit.
// Recall: a reference cut is HIT when engine cuts cover ≥50% of its span.
// Precision proxy: "keeps the reference says must survive" are violated when
// engine cuts cover more than a few seconds of them (excluding any allowed
// reference-cut sub-spans inside the keep).

export interface Span {
	start: number;
	end: number;
}

export interface ReferenceCut extends Span {
	/** Marker-driven cut (spoken edit command) — tracked as its own recall. */
	marker: boolean;
	label: string;
}

export interface ReferenceKeep extends Span {
	label: string;
	/** Reference cuts that legitimately live inside this keep. */
	allowed: Span[];
}

export interface ReferenceEdit {
	cuts: ReferenceCut[];
	keeps: ReferenceKeep[];
}

export const HIT_COVERAGE = 0.5;
export const KEEP_TOLERANCE_SEC = 3;

/** Seconds of `span` covered by the union of `cuts`, minus `excluded` spans. */
export function coveredSeconds(
	span: Span,
	cuts: Span[],
	excluded: Span[] = [],
): number {
	// Clip cuts to the span, subtract exclusions, then merge and sum.
	const clipped: Span[] = [];
	for (const c of cuts) {
		let pieces: Span[] = [
			{ start: Math.max(c.start, span.start), end: Math.min(c.end, span.end) },
		];
		for (const ex of excluded) {
			const next: Span[] = [];
			for (const p of pieces) {
				if (ex.end <= p.start || ex.start >= p.end) {
					next.push(p);
					continue;
				}
				if (ex.start > p.start) next.push({ start: p.start, end: ex.start });
				if (ex.end < p.end) next.push({ start: ex.end, end: p.end });
			}
			pieces = next;
		}
		for (const p of pieces) if (p.end > p.start) clipped.push(p);
	}
	if (clipped.length === 0) return 0;
	clipped.sort((a, b) => a.start - b.start);
	let total = 0;
	let cur = { ...clipped[0] };
	for (let i = 1; i < clipped.length; i++) {
		const c = clipped[i];
		if (c.start <= cur.end) {
			cur.end = Math.max(cur.end, c.end);
		} else {
			total += cur.end - cur.start;
			cur = { ...c };
		}
	}
	total += cur.end - cur.start;
	return total;
}

export interface Scorecard {
	hits: number;
	total: number;
	markerHits: number;
	markerTotal: number;
	missed: Array<{
		label: string;
		start: number;
		end: number;
		coverage: number;
	}>;
	keepViolations: Array<{ label: string; seconds: number }>;
}

export function scoreAgainstReference({
	reference,
	engineCuts,
}: {
	reference: ReferenceEdit;
	engineCuts: Span[];
}): Scorecard {
	let hits = 0;
	let markerHits = 0;
	const missed: Scorecard["missed"] = [];
	for (const ref of reference.cuts) {
		const dur = ref.end - ref.start;
		const coverage = dur > 0 ? coveredSeconds(ref, engineCuts) / dur : 0;
		if (coverage >= HIT_COVERAGE) {
			hits++;
			if (ref.marker) markerHits++;
		} else {
			missed.push({
				label: ref.label,
				start: ref.start,
				end: ref.end,
				coverage: Math.round(coverage * 100) / 100,
			});
		}
	}
	const keepViolations: Scorecard["keepViolations"] = [];
	for (const keep of reference.keeps) {
		const seconds = coveredSeconds(keep, engineCuts, keep.allowed);
		if (seconds > KEEP_TOLERANCE_SEC) {
			keepViolations.push({
				label: keep.label,
				seconds: Math.round(seconds * 10) / 10,
			});
		}
	}
	return {
		hits,
		total: reference.cuts.length,
		markerHits,
		markerTotal: reference.cuts.filter((c) => c.marker).length,
		missed,
		keepViolations,
	};
}
