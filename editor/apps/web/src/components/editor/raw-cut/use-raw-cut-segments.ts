"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { recordEdit, redoEdit, undoEdit } from "@/lib/raw-cut/edit-history";
import {
	type RawCutSegment,
	buildSegments,
	carryManualEdits,
	cutRangesOf,
	nextBoundary,
	prevBoundary,
	segmentIndexAt,
	segmentMarkers,
	skipDecision,
	splitAt,
	sweepCutFrom,
	toggleStatusAt,
	unwindStart,
} from "@/lib/raw-cut/segments";
import type { RawCutSegmentState } from "@/lib/raw-cut/session-cache";

interface Range {
	startSec: number;
	endSec: number;
}

/** Content fingerprint of the detection input. The rebuild only fires when this
 *  actually changes — so restoring a session (which produces an identical
 *  fingerprint with fresh array refs) does NOT clobber the user's manual cuts. */
function signatureOf(ranges: Range[], bufferDuration: number): string {
	let s = bufferDuration.toFixed(4);
	for (const r of ranges) {
		s += `|${r.startSec.toFixed(4)}-${r.endSec.toFixed(4)}`;
	}
	return s;
}

/**
 * Owns the editable Raw Cut segment list + the keyboard ops over it. Segments
 * are rebuilt from detection (`cutRanges`); manual toggles persist until the
 * next re-detect. Segments live in buffer time; the playhead/seek live in media
 * time, so we convert at the boundary (`k = mediaDuration / bufferDuration`).
 *
 * `initial` restores a prior session (Edit↔Raw Cut round-trip) without a
 * detection-rebuild wiping the restored toggles — see `signatureOf`.
 */
export function useRawCutSegments({
	cutRanges,
	bufferDuration,
	mediaDuration,
	currentTime,
	seekTo,
	skipSeek,
	initial,
	preserveManualEdits,
}: {
	cutRanges: Range[];
	bufferDuration: number;
	mediaDuration: number;
	currentTime: number;
	seekTo: (mediaSec: number) => void;
	// Used only by the cut-skip playback jump. Should pause→seek→play so the
	// audio output queue flushes (a plain currentTime= on a playing element
	// leaks ~0.5s of the cut region past the boundary). Falls back to seekTo.
	skipSeek?: (mediaSec: number) => void;
	initial?: RawCutSegmentState;
	// Final Pass passes true: a Re-analyze rebuild PRESERVES the user's manual
	// keep/cut edits (clips flagged userSet) instead of reseeding them, so the
	// learning loop's before→after diff survives. Raw Cut omits it (default false)
	// → byte-identical re-detect behavior (only lock/mark carry, as before).
	preserveManualEdits?: boolean;
}) {
	const [segments, setSegments] = useState<RawCutSegment[]>(
		() => initial?.segments ?? [],
	);
	const historyRef = useRef<RawCutSegment[][]>(initial?.history ?? []);
	// Redo stack — populated by undo, drained by redo, cleared on any new edit
	// (new branch). Final Pass binds redo to Shift+Cmd+Z; Raw Cut never reads it.
	const redoRef = useRef<RawCutSegment[][]>([]);
	const builtSigRef = useRef<string | null>(initial?.builtSignature ?? null);

	const sig = useMemo(
		() => signatureOf(cutRanges, bufferDuration),
		[cutRanges, bufferDuration],
	);

	// Rebuild only when the detection content actually changes. A session
	// restore reproduces the same signature, so the restored segments survive.
	useEffect(() => {
		// Don't build until the buffer is loaded. On a reload the buffer arrives
		// async AFTER restored segments are already in state — rebuilding here
		// (with bufferDuration still 0) would wipe the user's cuts.
		if (bufferDuration <= 0) return;
		if (builtSigRef.current === sig) return;
		builtSigRef.current = sig;
		historyRef.current = [];
		redoRef.current = [];
		setSegments((prev) =>
			carryManualEdits(
				prev,
				buildSegments({ durationSec: bufferDuration, cutRanges }),
				{ preserveStatus: preserveManualEdits },
			),
		);
	}, [sig, cutRanges, bufferDuration, preserveManualEdits]);

	const k = useMemo(
		() =>
			bufferDuration > 0 && mediaDuration > 0
				? mediaDuration / bufferDuration
				: 1,
		[bufferDuration, mediaDuration],
	);
	const mediaToBuf = useCallback((t: number) => t / k, [k]);
	const bufToMedia = useCallback((t: number) => t * k, [k]);

	const playheadBuf = mediaToBuf(currentTime);
	const currentIndex = segmentIndexAt(segments, playheadBuf);

	// Latest segments/k for the playback loop, so `onPlaybackTick` stays a stable
	// callback (the rAF loop in the surface depends on it without restarting).
	const segmentsRef = useRef(segments);
	segmentsRef.current = segments;
	const kRef = useRef(k);
	kRef.current = k;

	// Media-sec target of an in-flight skip seek. A media element's currentTime
	// can read stale for a frame or two right after a seek; without this guard
	// that stale (still-in-cut) frame re-fires the skip, causing pause/play
	// stutter at every boundary.
	const skipTargetRef = useRef<number | null>(null);

	// Called each rAF frame while playing. With `opts.leadSec > 0` the skip is
	// PREDICTIVE — it jumps to the next KEEP just BEFORE the playhead reaches a
	// keep→cut boundary, so no red audio is ever queued to the output (the leak fix
	// Andy hit). `leadSec` defaults to 0, which is the old reactive behavior (skip
	// only once inside a cut) — Raw Cut calls without opts and is unaffected.
	// `opts.playThroughUntilSec` (Final Pass) lets playback run THROUGH a cut you
	// started inside (see skipDecision); Raw Cut omits it → unchanged.
	// Returns "stop" when there's no further green to play (end the playback).
	const onPlaybackTick = useCallback(
		(
			mediaSec: number,
			opts?: { leadSec?: number; playThroughUntilSec?: number },
		): "continue" | "stop" => {
			const segs = segmentsRef.current;
			const kk = kRef.current;
			// Clear the guard once the element has actually arrived at the target.
			if (
				skipTargetRef.current != null &&
				mediaSec >= skipTargetRef.current - 0.05
			) {
				skipTargetRef.current = null;
			}
			const decision = skipDecision({
				segments: segs,
				mediaSec,
				k: kk,
				leadSec: opts?.leadSec ?? 0,
				playThroughUntilSec: opts?.playThroughUntilSec,
			});
			if (decision.action === "continue") return "continue";
			if (decision.action === "stop") return "stop";
			const targetMedia = decision.targetMediaSec;
			// Skip already issued for this boundary; the element hasn't caught up yet
			// — don't re-fire (would stutter pause/play).
			if (
				skipTargetRef.current != null &&
				Math.abs(targetMedia - skipTargetRef.current) < 0.01
			) {
				return "continue";
			}
			skipTargetRef.current = targetMedia;
			(skipSeek ?? seekTo)(targetMedia);
			return "continue";
		},
		[seekTo, skipSeek],
	);

	// --- mutation plumbing (undo/redo stack; pure transitions in edit-history.ts) ---
	const commit = useCallback((next: RawCutSegment[]) => {
		setSegments((prev) => {
			if (next === prev) return prev;
			const stacks = recordEdit(
				{ history: historyRef.current, redo: redoRef.current },
				prev,
				{ cap: 100 },
			);
			historyRef.current = stacks.history;
			redoRef.current = stacks.redo;
			return next;
		});
	}, []);

	const toggleIndex = useCallback((index: number) => {
		setSegments((prev) => {
			const next = toggleStatusAt(prev, index);
			if (next === prev) return prev;
			const stacks = recordEdit(
				{ history: historyRef.current, redo: redoRef.current },
				prev,
			);
			historyRef.current = stacks.history;
			redoRef.current = stacks.redo;
			return next;
		});
	}, []);

	const undo = useCallback(() => {
		setSegments((prev) => {
			const r = undoEdit(
				{ history: historyRef.current, redo: redoRef.current },
				prev,
			);
			if (!r) return prev;
			historyRef.current = r.stacks.history;
			redoRef.current = r.stacks.redo;
			return r.segments;
		});
	}, []);

	const redo = useCallback(() => {
		setSegments((prev) => {
			const r = redoEdit(
				{ history: historyRef.current, redo: redoRef.current },
				prev,
			);
			if (!r) return prev;
			historyRef.current = r.stacks.history;
			redoRef.current = r.stacks.redo;
			return r.segments;
		});
	}, []);

	// --- toggles (Andy's Q / W / E = prev / current / next clip) ---
	const toggleCurrent = useCallback(
		() => toggleIndex(segmentIndexAt(segments, playheadBuf)),
		[toggleIndex, segments, playheadBuf],
	);
	const togglePrev = useCallback(
		() => toggleIndex(segmentIndexAt(segments, playheadBuf) - 1),
		[toggleIndex, segments, playheadBuf],
	);
	const toggleNext = useCallback(
		() => toggleIndex(segmentIndexAt(segments, playheadBuf) + 1),
		[toggleIndex, segments, playheadBuf],
	);

	// Shift+Q / Shift+E — toggle the previous / next GREEN clip (skipping over
	// any already-cut clips between). Lets Andy kill a clip he just shift-navved
	// past without having to seek back to it first.
	const togglePrevGreen = useCallback(() => {
		const idx = segmentIndexAt(segments, playheadBuf);
		for (let i = idx - 1; i >= 0; i--) {
			if (segments[i].status === "keep") {
				toggleIndex(i);
				return;
			}
		}
	}, [segments, playheadBuf, toggleIndex]);
	const toggleNextGreen = useCallback(() => {
		const idx = segmentIndexAt(segments, playheadBuf);
		for (let i = idx + 1; i < segments.length; i++) {
			if (segments[i].status === "keep") {
				toggleIndex(i);
				return;
			}
		}
	}, [segments, playheadBuf, toggleIndex]);

	// O — toggle current, then advance the playhead to the next segment start.
	const cycleAndAdvance = useCallback(() => {
		const idx = segmentIndexAt(segments, playheadBuf);
		toggleIndex(idx);
		const next = segments[idx + 1];
		if (next) seekTo(bufToMedia(next.startSec));
	}, [segments, playheadBuf, toggleIndex, seekTo, bufToMedia]);

	// Shift+O — sweep current + following keeps to cut (stop at a lock).
	const sweepForward = useCallback(() => {
		const idx = segmentIndexAt(segments, playheadBuf);
		commit(sweepCutFrom(segments, idx));
	}, [segments, playheadBuf, commit]);

	// H / M — lock / mark the current segment.
	const toggleLock = useCallback(() => {
		const idx = segmentIndexAt(segments, playheadBuf);
		commit(
			segments.map((s, i) => (i === idx ? { ...s, locked: !s.locked } : s)),
		);
	}, [segments, playheadBuf, commit]);
	const toggleMark = useCallback(() => {
		const idx = segmentIndexAt(segments, playheadBuf);
		commit(
			segments.map((s, i) => (i === idx ? { ...s, marked: !s.marked } : s)),
		);
	}, [segments, playheadBuf, commit]);

	// S — split at the playhead.
	const splitHere = useCallback(() => {
		commit(splitAt(segments, playheadBuf));
	}, [segments, playheadBuf, commit]);

	// --- navigation (seek only; convert buffer→media) ---
	const seekBuf = useCallback(
		(bufSec: number | null) => {
			if (bufSec == null) return;
			seekTo(bufToMedia(bufSec));
		},
		[seekTo, bufToMedia],
	);
	// Shift+→ / Shift+← — jump to the next/prev GREEN clip and SELECT it. We
	// index off the current segment (not a raw time threshold) and land the
	// playhead a hair INSIDE the destination clip, so the selection is always
	// the clip in front of the playhead, never the one ending at the boundary
	// behind it (which float drift in the buffer↔media `k` conversion could
	// otherwise pick). Andy's ask: "always select the clip in front."
	const seekIntoSegment = useCallback(
		(s: RawCutSegment) => {
			const NUDGE_BUF = 0.02;
			const target =
				s.startSec + Math.min(NUDGE_BUF, (s.endSec - s.startSec) / 2);
			seekBuf(target);
		},
		[seekBuf],
	);
	const gotoNextGreen = useCallback(() => {
		const idx = segmentIndexAt(segments, playheadBuf);
		for (let i = idx + 1; i < segments.length; i++) {
			if (segments[i].status === "keep") {
				seekIntoSegment(segments[i]);
				return;
			}
		}
	}, [segments, playheadBuf, seekIntoSegment]);
	const gotoPrevGreen = useCallback(() => {
		const idx = segmentIndexAt(segments, playheadBuf);
		for (let i = idx - 1; i >= 0; i--) {
			if (segments[i].status === "keep") {
				seekIntoSegment(segments[i]);
				return;
			}
		}
	}, [segments, playheadBuf, seekIntoSegment]);
	const gotoNextBoundary = useCallback(
		() => seekBuf(nextBoundary(segments, playheadBuf)),
		[seekBuf, segments, playheadBuf],
	);
	const gotoPrevBoundary = useCallback(
		() => seekBuf(prevBoundary(segments, playheadBuf)),
		[seekBuf, segments, playheadBuf],
	);
	const unwind = useCallback(
		() => seekBuf(unwindStart(segments, playheadBuf, 3)),
		[seekBuf, segments, playheadBuf],
	);

	const displayCutRanges = useMemo(() => cutRangesOf(segments), [segments]);
	const markers = useMemo(() => segmentMarkers(segments), [segments]);
	const current = currentIndex >= 0 ? segments[currentIndex] : null;

	// Snapshot for the session cache. Identity changes when `segments` changes,
	// so the parent's persist effect can depend on it.
	const exportState = useCallback(
		(): RawCutSegmentState => ({
			segments,
			history: historyRef.current,
			builtSignature: builtSigRef.current,
		}),
		[segments],
	);

	return {
		segments,
		currentIndex,
		current,
		displayCutRanges,
		markers,
		exportState,
		onPlaybackTick,
		// toggles
		toggleCurrent,
		togglePrev,
		toggleNext,
		togglePrevGreen,
		toggleNextGreen,
		cycleAndAdvance,
		sweepForward,
		toggleLock,
		toggleMark,
		splitHere,
		undo,
		redo,
		// nav
		gotoNextGreen,
		gotoPrevGreen,
		gotoNextBoundary,
		gotoPrevBoundary,
		unwind,
	};
}
