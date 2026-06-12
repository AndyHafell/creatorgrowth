// Pure waveform-peak extraction — split out of audio.ts so it can be unit
// tested (audio.ts pulls in opencut-wasm at module load, which doesn't run
// under bun test). audio.ts re-exports these, so callers are unchanged.

const COARSE_SAMPLE_COUNT = 2048;

export function computeGlobalMaxRms({
	buffer,
}: {
	buffer: AudioBuffer;
}): number {
	const channels = buffer.numberOfChannels;
	const step = Math.max(1, Math.floor(buffer.length / COARSE_SAMPLE_COUNT));
	let globalMax = 0;

	for (let c = 0; c < channels; c++) {
		const data = buffer.getChannelData(c);
		for (let i = 0; i + step <= buffer.length; i += step) {
			for (let j = i; j < i + step; j++) {
				const abs = Math.abs(data[j]);
				if (abs > globalMax) globalMax = abs;
			}
		}
	}

	return globalMax || 1;
}

/**
 * Map a clip's drawn pixel range onto its SOURCE sample window.
 *
 * A timeline clip is a window into its source: the clip's full width spans
 * [trimStart, trimStart + visibleDuration * playbackRate] in source time.
 * The old waveform mapped pixels over the whole buffer instead, so every
 * trimmed Raw Cut segment drew the full file's peaks — speech rendered as the
 * source's silences and vice versa.
 */
export function computeWaveformSampleWindow({
	bufferLength,
	sampleRate,
	trimStartSec,
	visibleDurationSec,
	playbackRate = 1,
	clipLeftPx,
	drawWidthPx,
	fullWidthPx,
}: {
	bufferLength: number;
	sampleRate: number;
	trimStartSec: number;
	visibleDurationSec: number;
	playbackRate?: number;
	clipLeftPx: number;
	drawWidthPx: number;
	fullWidthPx: number;
}): { startSample: number; endSample: number } {
	if (fullWidthPx <= 0 || drawWidthPx <= 0) {
		return { startSample: 0, endSample: 0 };
	}
	const sourceWindowSec = visibleDurationSec * playbackRate;
	const windowStartSec =
		trimStartSec + (clipLeftPx / fullWidthPx) * sourceWindowSec;
	const windowEndSec =
		trimStartSec + ((clipLeftPx + drawWidthPx) / fullWidthPx) * sourceWindowSec;
	const startSample = Math.min(
		bufferLength,
		Math.max(0, Math.floor(windowStartSec * sampleRate)),
	);
	const endSample = Math.min(
		bufferLength,
		Math.max(startSample, Math.ceil(windowEndSec * sampleRate)),
	);
	return { startSample, endSample };
}

export const WAVEFORM_BLOCK_SIZE = 64;

/**
 * One-time per-buffer envelope: max |sample| per fixed block across all
 * channels. Lets every later redraw read O(blocks-in-range) instead of
 * rescanning raw samples — the raw scan was the timeline-zoom hitch (every
 * clip re-rasterized the whole 13-min buffer per zoom tick).
 */
export function buildWaveformBlockCache({
	buffer,
	blockSize = WAVEFORM_BLOCK_SIZE,
}: {
	buffer: AudioBuffer;
	blockSize?: number;
}): Float32Array {
	const blocks = Math.ceil(buffer.length / blockSize);
	const out = new Float32Array(blocks);
	for (let c = 0; c < buffer.numberOfChannels; c++) {
		const data = buffer.getChannelData(c);
		for (let b = 0; b < blocks; b++) {
			const start = b * blockSize;
			const end = Math.min(start + blockSize, buffer.length);
			let max = out[b];
			for (let i = start; i < end; i++) {
				const abs = Math.abs(data[i]);
				if (abs > max) max = abs;
			}
			out[b] = max;
		}
	}
	return out;
}

/**
 * Same contract as extractRmsRange (fractional bins over [start, end), peaks
 * normalized by globalMax) but reading block maxima. Edge bins overscan to
 * block boundaries, so detail can smear by at most one block (~8ms at 8kHz) —
 * callers should drop to extractRmsRange when bins get near block size.
 */
export function extractPeaksFromBlockCache({
	blockMax,
	blockSize,
	count,
	startSample,
	endSample,
	globalMax,
}: {
	blockMax: Float32Array;
	blockSize: number;
	count: number;
	startSample: number;
	endSample: number;
	globalMax: number;
}): number[] {
	const result = new Array<number>(count).fill(0);
	const rangeLength = endSample - startSample;
	if (rangeLength <= 0 || count <= 0) return result;

	const step = rangeLength / count;
	const norm = 1 / globalMax;
	for (let i = 0; i < count; i++) {
		const start = startSample + Math.floor(i * step);
		const end = Math.min(
			Math.max(start + 1, startSample + Math.floor((i + 1) * step)),
			endSample,
		);
		const blockStart = Math.max(0, Math.floor(start / blockSize));
		const blockEnd = Math.min(
			blockMax.length - 1,
			Math.floor((end - 1) / blockSize),
		);
		let max = 0;
		for (let b = blockStart; b <= blockEnd; b++) {
			if (blockMax[b] > max) max = blockMax[b];
		}
		result[i] = Math.min(1, max * norm);
	}
	return result;
}

export function extractRmsRange({
	buffer,
	count,
	startSample,
	endSample,
	globalMax,
}: {
	buffer: AudioBuffer;
	count: number;
	startSample: number;
	endSample: number;
	globalMax: number;
}): number[] {
	const channels = buffer.numberOfChannels;
	const rangeLength = endSample - startSample;
	const peaks = new Float32Array(count);
	if (rangeLength > 0 && count > 0) {
		// Fractional bin boundaries: column i covers samples
		// [start + i*step, start + (i+1)*step). A FLOORED integer step here let
		// the truncation error accumulate across the viewport, drifting the drawn
		// wave against the keep/cut bands by up to ~0.3s depending on zoom (the
		// Raw Cut "red/green doesn't line up unless fully zoomed in" bug).
		const step = rangeLength / count;
		for (let c = 0; c < channels; c++) {
			const data = buffer.getChannelData(c);
			for (let i = 0; i < count; i++) {
				const start = startSample + Math.floor(i * step);
				const end = Math.min(
					Math.max(start + 1, startSample + Math.floor((i + 1) * step)),
					endSample,
				);
				for (let j = start; j < end; j++) {
					const abs = Math.abs(data[j]);
					if (abs > peaks[i]) peaks[i] = abs;
				}
			}
		}
	}

	const norm = 1 / globalMax;
	const result = new Array<number>(count);
	for (let i = 0; i < count; i++) result[i] = Math.min(1, peaks[i] * norm);

	return result;
}
