import type { TimelineWord } from "./types";

// Maps between MEDIA time (what the Raw Cut transcript is in — original
// source seconds) and TIMELINE time (where cuts/trims have been applied).
// Semantics verified against scene-builder.ts/resolve.ts: an element occupies
// timeline [startTime, startTime + duration] and shows media starting at
// trimStart, so mediaTime = trimStart + (timelineTime - startTime).

/** The slice of a timeline element we need — all values in ticks. */
export interface ElementWindow {
	startTime: number;
	trimStart: number;
	trimEnd: number;
	duration: number;
}

interface SecWindow {
	timelineStart: number;
	timelineEnd: number;
	mediaStart: number;
	mediaEnd: number;
}

function toSecWindows({
	elements,
	ticksPerSecond,
}: {
	elements: ElementWindow[];
	ticksPerSecond: number;
}): SecWindow[] {
	return [...elements]
		.sort((a, b) => a.startTime - b.startTime)
		.map((el) => {
			const timelineStart = el.startTime / ticksPerSecond;
			const durationSec = el.duration / ticksPerSecond;
			const mediaStart = el.trimStart / ticksPerSecond;
			return {
				timelineStart,
				timelineEnd: timelineStart + durationSec,
				mediaStart,
				mediaEnd: mediaStart + durationSec,
			};
		});
}

/**
 * Map media-time words onto the timeline. Words whose start falls in cut
 * content are dropped; words straddling a window end are clamped to it.
 */
export function mapWordsToTimeline({
	words,
	elements,
	ticksPerSecond,
}: {
	words: TimelineWord[];
	elements: ElementWindow[];
	ticksPerSecond: number;
}): TimelineWord[] {
	const windows = toSecWindows({ elements, ticksPerSecond });
	const out: TimelineWord[] = [];
	for (const word of words) {
		const win = windows.find(
			(w) => word.start >= w.mediaStart && word.start < w.mediaEnd,
		);
		if (!win) continue;
		const offset = win.timelineStart - win.mediaStart;
		out.push({
			text: word.text,
			start: word.start + offset,
			end: Math.min(word.end, win.mediaEnd) + offset,
		});
	}
	return out;
}

/** Media second → timeline second (null when the moment was cut out). */
export function mediaSecToTimelineSec({
	mediaSec,
	elements,
	ticksPerSecond,
}: {
	mediaSec: number;
	elements: ElementWindow[];
	ticksPerSecond: number;
}): number | null {
	const windows = toSecWindows({ elements, ticksPerSecond });
	const win = windows.find(
		(w) => mediaSec >= w.mediaStart && mediaSec < w.mediaEnd,
	);
	if (!win) return null;
	return win.timelineStart + (mediaSec - win.mediaStart);
}

/** Inverse map for frame sampling: timeline second → media second (null in gaps). */
export function timelineSecToMediaSec({
	timelineSec,
	elements,
	ticksPerSecond,
}: {
	timelineSec: number;
	elements: ElementWindow[];
	ticksPerSecond: number;
}): number | null {
	const windows = toSecWindows({ elements, ticksPerSecond });
	const win = windows.find(
		(w) => timelineSec >= w.timelineStart && timelineSec < w.timelineEnd,
	);
	if (!win) return null;
	return win.mediaStart + (timelineSec - win.timelineStart);
}
