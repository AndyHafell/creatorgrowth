import type { SilenceRange } from "@/lib/media/audio";

/**
 * A keep-region preserves a [keepStartSec, keepEndSec] slice of the original
 * audio at [splicedStartSec, splicedEndSec] in the spliced output. Used to
 * remap Whisper segment timestamps from spliced-coords back to original-coords.
 */
export interface KeepRegion {
	keepStartSec: number;
	keepEndSec: number;
	splicedStartSec: number;
	splicedEndSec: number;
}

export interface SplicedAudio {
	/** PCM mono Float32Array at the same sample rate as the input. */
	samples: Float32Array;
	/** Sorted keep regions for splice→original timestamp remap. */
	keeps: KeepRegion[];
	/** Total duration of the spliced audio in seconds (samples / sampleRate). */
	durationSec: number;
}

/**
 * Splice an input Float32Array (mono PCM at sampleRate) by REMOVING the
 * silence ranges and concatenating the remaining keep regions. Returns the
 * compacted samples + a remap table so segment timestamps in spliced coords
 * can be translated back to original-timeline coords.
 *
 * Why: Whisper time scales linearly with input length. Skipping the silences
 * (typically 30-50% of a talking-head take) is the biggest single speed win
 * — and silences carry no signal Whisper would use anyway.
 */
export function spliceKeepRegions({
	samples,
	silenceRanges,
	sampleRate,
}: {
	samples: Float32Array;
	silenceRanges: SilenceRange[];
	sampleRate: number;
}): SplicedAudio {
	const totalDurationSec = samples.length / sampleRate;

	// Invert silence ranges → keep ranges in ORIGINAL time.
	const sorted = [...silenceRanges]
		.filter((r) => r.endSec > r.startSec)
		.sort((a, b) => a.startSec - b.startSec);

	const keepRanges: { startSec: number; endSec: number }[] = [];
	let cursor = 0;
	for (const r of sorted) {
		const s = Math.max(0, Math.min(totalDurationSec, r.startSec));
		const e = Math.max(0, Math.min(totalDurationSec, r.endSec));
		if (s > cursor) {
			keepRanges.push({ startSec: cursor, endSec: s });
		}
		cursor = Math.max(cursor, e);
	}
	if (cursor < totalDurationSec) {
		keepRanges.push({ startSec: cursor, endSec: totalDurationSec });
	}

	// If there are no silences (or no keeps), short-circuit.
	if (keepRanges.length === 0) {
		return {
			samples: new Float32Array(0),
			keeps: [],
			durationSec: 0,
		};
	}

	// Total output sample count.
	let totalKeepSamples = 0;
	const keepSampleCounts: number[] = [];
	for (const k of keepRanges) {
		const startIdx = Math.max(0, Math.floor(k.startSec * sampleRate));
		const endIdx = Math.min(samples.length, Math.ceil(k.endSec * sampleRate));
		const n = Math.max(0, endIdx - startIdx);
		keepSampleCounts.push(n);
		totalKeepSamples += n;
	}

	const out = new Float32Array(totalKeepSamples);
	const keeps: KeepRegion[] = [];
	let writeIdx = 0;
	for (let i = 0; i < keepRanges.length; i++) {
		const k = keepRanges[i];
		const n = keepSampleCounts[i];
		if (n === 0) continue;
		const startIdx = Math.max(0, Math.floor(k.startSec * sampleRate));
		out.set(samples.subarray(startIdx, startIdx + n), writeIdx);
		const splicedStartSec = writeIdx / sampleRate;
		const splicedEndSec = (writeIdx + n) / sampleRate;
		keeps.push({
			keepStartSec: k.startSec,
			keepEndSec: k.startSec + n / sampleRate,
			splicedStartSec,
			splicedEndSec,
		});
		writeIdx += n;
	}

	return {
		samples: out,
		keeps,
		durationSec: out.length / sampleRate,
	};
}

/**
 * Map a single timestamp from spliced-audio coords back to the original
 * timeline. Snaps to the containing keep region; if the timestamp falls
 * past the spliced length (Whisper rounding), clamps to the last keep's
 * end. If no keeps cover it, returns the last seen original time.
 */
export function remapSplicedSecToOriginal({
	splicedSec,
	keeps,
}: {
	splicedSec: number;
	keeps: KeepRegion[];
}): number {
	if (keeps.length === 0) return splicedSec;
	if (splicedSec <= keeps[0].splicedStartSec) {
		return keeps[0].keepStartSec;
	}
	// Binary search for the keep region containing splicedSec.
	let lo = 0;
	let hi = keeps.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (keeps[mid].splicedEndSec < splicedSec) {
			lo = mid + 1;
		} else {
			hi = mid;
		}
	}
	const k = keeps[lo];
	if (splicedSec >= k.splicedEndSec) {
		return k.keepEndSec;
	}
	const localOffset = splicedSec - k.splicedStartSec;
	return k.keepStartSec + Math.max(0, localOffset);
}

export interface RemappedSegment {
	text: string;
	start: number;
	end: number;
}

/**
 * Remap a list of segments from spliced coords → original coords. Drops
 * zero/negative-length segments after remap.
 */
export function remapSegments({
	segments,
	keeps,
}: {
	segments: { text: string; start: number; end: number }[];
	keeps: KeepRegion[];
}): RemappedSegment[] {
	const out: RemappedSegment[] = [];
	for (const s of segments) {
		const start = remapSplicedSecToOriginal({ splicedSec: s.start, keeps });
		const end = remapSplicedSecToOriginal({ splicedSec: s.end, keeps });
		if (end > start) {
			out.push({ text: s.text, start, end });
		}
	}
	return out;
}
