import type { TimelineWord } from "./types";

// Choosing the right cached Raw Cut transcription for the open clip. The OPFS
// cache is keyed by (contentHash, modelId) and the modelId can be anything —
// Scribe, the -rawcut variant, or a dynamic whisper HF id — so the caller
// scans the whole cache dir and this picker decides:
//   1. exact hash match (prefer word-level entries, then more segments)
//   2. else the most recent entry whose transcript span fits the media
//      duration (covers hash drift when the file was copied/re-containered
//      between Raw Cut and the editor project)

export interface TranscriptEntry {
	contentHash: string;
	modelId: string;
	segments: Array<{ text: string; start: number; end: number }>;
	words?: TimelineWord[];
	createdAt: number;
}

/** How far (fraction) a fuzzy match's span may sit from the media duration. */
const FUZZY_SPAN_TOLERANCE = 0.3;

function span(entry: TranscriptEntry): number {
	let max = 0;
	for (const seg of entry.segments) max = Math.max(max, seg.end);
	if (entry.words) {
		for (const w of entry.words) max = Math.max(max, w.end);
	}
	return max;
}

function richness(entry: TranscriptEntry): number {
	// Word-level entries always beat segment-only ones.
	return (entry.words?.length ? 1_000_000 : 0) + entry.segments.length;
}

export function pickTranscript({
	entries,
	contentHash,
	mediaDurationSec,
}: {
	entries: TranscriptEntry[];
	contentHash: string;
	mediaDurationSec: number | null;
}): TranscriptEntry | null {
	const exact = entries.filter((e) => e.contentHash === contentHash);
	if (exact.length > 0) {
		return exact.reduce((best, e) => (richness(e) > richness(best) ? e : best));
	}

	if (mediaDurationSec === null || mediaDurationSec <= 0) return null;
	const fuzzy = entries.filter(
		(e) =>
			Math.abs(span(e) - mediaDurationSec) <=
			mediaDurationSec * FUZZY_SPAN_TOLERANCE,
	);
	if (fuzzy.length === 0) return null;
	return fuzzy.reduce((best, e) => (e.createdAt > best.createdAt ? e : best));
}
