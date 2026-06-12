/**
 * Raw Cut segment model. The timeline is partitioned into contiguous clips
 * ("segments"), each kept (green) or cut (red), plus lock/mark flags. Built
 * from the detected cut ranges, then edited by the keyboard scheme (§8 + Andy's
 * Q/W/E toggles). This is also the state Step 5 will export to the real timeline.
 *
 * Segments live in the *buffer* timebase (same as the waveform bands). Callers
 * convert to/from media time at the playhead/seek boundary.
 */

export type SegmentStatus = "keep" | "cut";

export interface RawCutSegment {
	id: string;
	startSec: number;
	endSec: number;
	status: SegmentStatus;
	locked: boolean;
	marked: boolean;
	// True once the user manually flipped this clip's keep/cut status. Final Pass
	// uses it to PRESERVE hand edits across a Re-analyze (see carryManualEdits with
	// preserveStatus). Optional so existing/cached segments stay valid.
	userSet?: boolean;
}

interface Range {
	startSec: number;
	endSec: number;
}

function mergeRanges(ranges: Range[], durationSec: number): Range[] {
	const clamped = ranges
		.map((r) => ({
			startSec: Math.max(0, Math.min(durationSec, r.startSec)),
			endSec: Math.max(0, Math.min(durationSec, r.endSec)),
		}))
		.filter((r) => r.endSec > r.startSec)
		.sort((a, b) => a.startSec - b.startSec);

	const merged: Range[] = [];
	for (const r of clamped) {
		const last = merged[merged.length - 1];
		if (last && r.startSec <= last.endSec) {
			last.endSec = Math.max(last.endSec, r.endSec);
		} else {
			merged.push({ ...r });
		}
	}
	return merged;
}

/** Partition [0, durationSec] into alternating keep/cut segments. */
export function buildSegments({
	durationSec,
	cutRanges,
}: {
	durationSec: number;
	cutRanges: Range[];
}): RawCutSegment[] {
	if (!Number.isFinite(durationSec) || durationSec <= 0) return [];
	const cuts = mergeRanges(cutRanges, durationSec);
	const segs: RawCutSegment[] = [];
	let cursor = 0;
	let i = 0;
	const push = (start: number, end: number, status: SegmentStatus) => {
		if (end - start <= 0.0001) return;
		segs.push({
			id: `seg-${i++}-${start.toFixed(3)}`,
			startSec: start,
			endSec: end,
			status,
			locked: false,
			marked: false,
		});
	};
	for (const c of cuts) {
		push(cursor, c.startSec, "keep");
		push(c.startSec, c.endSec, "cut");
		cursor = c.endSec;
	}
	push(cursor, durationSec, "keep");
	if (segs.length === 0) {
		segs.push({
			id: "seg-0",
			startSec: 0,
			endSec: durationSec,
			status: "keep",
			locked: false,
			marked: false,
		});
	}
	return segs;
}

/** Index of the segment containing `sec`, clamped to the ends. -1 if empty. */
export function segmentIndexAt(segments: RawCutSegment[], sec: number): number {
	if (segments.length === 0) return -1;
	for (let i = 0; i < segments.length; i++) {
		if (sec < segments[i].endSec) return i;
	}
	return segments.length - 1;
}

/** The cut (red) segments as plain ranges, for the waveform. */
export function cutRangesOf(segments: RawCutSegment[]): Range[] {
	return segments
		.filter((s) => s.status === "cut")
		.map((s) => ({ startSec: s.startSec, endSec: s.endSec }));
}

/** Flag ticks (lock/mark) at segment starts, for the waveform. */
export function segmentMarkers(
	segments: RawCutSegment[],
): Array<{ sec: number; kind: "lock" | "mark" }> {
	const out: Array<{ sec: number; kind: "lock" | "mark" }> = [];
	for (const s of segments) {
		if (s.locked) out.push({ sec: s.startSec, kind: "lock" });
		if (s.marked) out.push({ sec: s.startSec, kind: "mark" });
	}
	return out;
}

/** Toggle a segment's status (no-op if locked or out of range). */
export function toggleStatusAt(
	segments: RawCutSegment[],
	index: number,
): RawCutSegment[] {
	if (index < 0 || index >= segments.length) return segments;
	if (segments[index].locked) return segments;
	return segments.map((s, i) =>
		i === index
			? { ...s, status: s.status === "keep" ? "cut" : "keep", userSet: true }
			: s,
	);
}

/** Turn the current segment and every following keep segment to cut, stopping
 *  at the first locked segment (TimeBolt Shift+O sweep). */
export function sweepCutFrom(
	segments: RawCutSegment[],
	fromIndex: number,
): RawCutSegment[] {
	if (fromIndex < 0) return segments;
	return segments.map((s, i) => {
		if (i < fromIndex) return s;
		if (s.locked) return s;
		return s.status === "keep" ? { ...s, status: "cut", userSet: true } : s;
	});
}

/**
 * Carry the user's manual edits from `prev` onto a freshly rebuilt `next`
 * (re-detect in Raw Cut, Re-analyze in Final Pass). Matched by midpoint overlap
 * — manual splits aren't preserved (the rebuild re-derives boundaries).
 *
 *  - lock/mark always carry (so a re-detect never drops a protected clip).
 *  - With `preserveStatus`, a clip the user manually flipped (`userSet`) keeps
 *    its keep/cut status too, so Re-analyze re-suggests ONLY in untouched
 *    regions. Final Pass passes this; Raw Cut omits it → identical to before.
 *
 * Returns `next` unchanged (same ref) when nothing carries, so callers can keep
 * their fresh-detection result when the user has made no edits.
 */
export function carryManualEdits(
	prev: RawCutSegment[],
	next: RawCutSegment[],
	opts?: { preserveStatus?: boolean },
): RawCutSegment[] {
	if (prev.length === 0) return next;
	const preserveStatus = opts?.preserveStatus ?? false;
	let changed = false;
	const merged = next.map((s) => {
		const mid = (s.startSec + s.endSec) / 2;
		const old = prev.find((p) => mid >= p.startSec && mid < p.endSec);
		if (!old) return s;
		const carryFlags = old.locked || old.marked;
		const carryStatus = preserveStatus && old.userSet === true;
		if (!carryFlags && !carryStatus) return s;
		changed = true;
		return {
			...s,
			...(carryFlags ? { locked: old.locked, marked: old.marked } : {}),
			...(carryStatus ? { status: old.status, userSet: true } : {}),
		};
	});
	return changed ? merged : next;
}

/** Insert a boundary at `sec`, splitting the containing segment in two. */
export function splitAt(
	segments: RawCutSegment[],
	sec: number,
): RawCutSegment[] {
	const idx = segmentIndexAt(segments, sec);
	if (idx < 0) return segments;
	const seg = segments[idx];
	if (sec <= seg.startSec + 0.0001 || sec >= seg.endSec - 0.0001) {
		return segments;
	}
	const left: RawCutSegment = { ...seg, endSec: sec };
	const right: RawCutSegment = {
		...seg,
		id: `${seg.id}-r`,
		startSec: sec,
	};
	return [...segments.slice(0, idx), left, right, ...segments.slice(idx + 1)];
}

/** First keep segment starting strictly after `sec` (Shift+→ / next green). */
export function nextKeepStart(
	segments: RawCutSegment[],
	sec: number,
): number | null {
	for (const s of segments) {
		if (s.status === "keep" && s.startSec > sec + 0.001) return s.startSec;
	}
	return null;
}

/** Last keep segment starting strictly before `sec` (Shift+← / prev green). */
export function prevKeepStart(
	segments: RawCutSegment[],
	sec: number,
): number | null {
	let found: number | null = null;
	for (const s of segments) {
		if (s.status === "keep" && s.startSec < sec - 0.001) found = s.startSec;
		else if (s.startSec >= sec) break;
	}
	return found;
}

/** Next/prev segment boundary (any), for ↑/↓ navigation. */
export function nextBoundary(
	segments: RawCutSegment[],
	sec: number,
): number | null {
	for (const s of segments) {
		if (s.startSec > sec + 0.001) return s.startSec;
	}
	const last = segments[segments.length - 1];
	return last ? last.endSec : null;
}

export function prevBoundary(
	segments: RawCutSegment[],
	sec: number,
): number | null {
	let found: number | null = null;
	for (const s of segments) {
		if (s.startSec < sec - 0.001) found = s.startSec;
		else break;
	}
	return found;
}

/** Start of the keep segment `count` greens before `sec` (U / unwind, count=3). */
export function unwindStart(
	segments: RawCutSegment[],
	sec: number,
	count: number,
): number | null {
	const greens = segments.filter((s) => s.status === "keep");
	// Index of the green at/just before the playhead.
	let cur = -1;
	for (let i = 0; i < greens.length; i++) {
		if (greens[i].startSec <= sec + 0.001) cur = i;
	}
	const target = Math.max(0, cur - count);
	return greens[target] ? greens[target].startSec : null;
}

export type SkipDecision =
	| { action: "continue" }
	| { action: "stop" }
	| { action: "skip"; targetMediaSec: number };

/**
 * Skip-cuts playback decision for one rAF frame. Decides whether to keep playing,
 * jump to the next keep (skipping a cut), or stop (no keep left).
 *
 * Segments live in the BUFFER timebase; the playhead/seek live in MEDIA time, so
 * we convert with `k` (= mediaDuration / bufferDuration). The returned skip target
 * is in MEDIA seconds, landing a hair INSIDE the keep so a boundary float-round
 * can't bounce back into the cut.
 *
 * `leadSec` (MEDIA seconds) makes the skip PREDICTIVE: when the playhead is within
 * `leadSec` of a keep→cut boundary it jumps BEFORE entering the red, so no cut
 * audio is ever queued to the output (the reactive-only version played a sliver of
 * red before reacting). `leadSec = 0` reproduces the old reactive behavior exactly
 * — it only skips once the playhead is already inside a cut (Raw Cut relies on
 * this). Boundaries are silence-snapped upstream, so the tiny clipped green tail
 * is inaudible.
 *
 * `playThroughUntilSec` (MEDIA seconds, optional) is the play-through guard: when
 * playback STARTS inside a cut Andy deliberately clicked into, the surface passes
 * the end of that cut run here. While `mediaSec < playThroughUntilSec` the reactive
 * skip is suppressed, so the red plays through; predictive green→red skips still
 * fire normally after the playhead leaves it. Raw Cut omits it (undefined → today's
 * behavior), so it stays byte-identical.
 */
export function skipDecision({
	segments,
	mediaSec,
	k,
	leadSec,
	playThroughUntilSec,
}: {
	segments: RawCutSegment[];
	mediaSec: number;
	k: number;
	leadSec: number;
	playThroughUntilSec?: number;
}): SkipDecision {
	const bufSec = mediaSec / k;
	const idx = segmentIndexAt(segments, bufSec);
	if (idx < 0) return { action: "continue" };
	const cur = segments[idx];

	// Where does the cut we must skip begin? Either we're already inside one
	// (reactive), or we're within `leadSec` of entering the next one (predictive).
	let cutStartIdx = -1;
	if (cur.status === "cut") {
		// Play-through: we started playback inside this cut run, so keep playing
		// until its end instead of reactively bailing out of the red.
		if (playThroughUntilSec != null && mediaSec < playThroughUntilSec) {
			return { action: "continue" };
		}
		cutStartIdx = idx;
	} else {
		const next = segments[idx + 1];
		const curEndMedia = cur.endSec * k;
		if (next && next.status === "cut" && curEndMedia - mediaSec <= leadSec) {
			cutStartIdx = idx + 1;
		}
	}
	if (cutStartIdx < 0) return { action: "continue" };

	// Land just inside the next keep at/after the cut run.
	for (let i = cutStartIdx; i < segments.length; i++) {
		if (segments[i].status === "keep") {
			const into =
				segments[i].startSec +
				Math.min(0.03, (segments[i].endSec - segments[i].startSec) / 2);
			return { action: "skip", targetMediaSec: into * k };
		}
	}
	return { action: "stop" };
}

/**
 * If `mediaSec` falls inside a cut (red) segment, return the MEDIA-time end of the
 * contiguous cut RUN containing it; otherwise null. Final Pass calls this at
 * play-start so playback can run THROUGH a cut Andy deliberately clicked into — the
 * returned value feeds `skipDecision`'s `playThroughUntilSec`, suppressing the
 * reactive skip until the playhead leaves the red. Raw Cut never calls it.
 * Segments are buffer-time; the playhead/seek are media-time, so we convert with
 * `k` (= mediaDuration / bufferDuration) on the way in and out.
 */
export function cutRunEndMediaSec({
	segments,
	mediaSec,
	k,
}: {
	segments: RawCutSegment[];
	mediaSec: number;
	k: number;
}): number | null {
	const bufSec = mediaSec / k;
	const idx = segmentIndexAt(segments, bufSec);
	if (idx < 0 || segments[idx].status !== "cut") return null;
	let endBuf = segments[idx].endSec;
	for (
		let i = idx + 1;
		i < segments.length && segments[i].status === "cut";
		i++
	) {
		endBuf = segments[i].endSec;
	}
	return endBuf * k;
}
