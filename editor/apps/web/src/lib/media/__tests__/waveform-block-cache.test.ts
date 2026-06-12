import { describe, expect, it } from "bun:test";
import {
	buildWaveformBlockCache,
	extractPeaksFromBlockCache,
	extractRmsRange,
} from "../rms";

// Minimal AudioBuffer stand-in — the cache builder only touches these members.
function fakeBuffer(channels: Float32Array[]): AudioBuffer {
	return {
		numberOfChannels: channels.length,
		length: channels[0].length,
		getChannelData: (c: number) => channels[c],
	} as unknown as AudioBuffer;
}

describe("buildWaveformBlockCache", () => {
	it("stores the max |sample| per block across all channels", () => {
		const left = new Float32Array(16);
		const right = new Float32Array(16);
		left[2] = 0.5;
		right[3] = -0.9; // negative peak in the other channel, same block
		right[12] = 0.25;
		const cache = buildWaveformBlockCache({
			buffer: fakeBuffer([left, right]),
			blockSize: 4,
		});
		expect(cache.length).toBe(4);
		expect(cache[0]).toBeCloseTo(0.9);
		expect(cache[1]).toBe(0);
		expect(cache[3]).toBeCloseTo(0.25);
	});

	it("handles a tail block shorter than blockSize", () => {
		const data = new Float32Array(10);
		data[9] = 1;
		const cache = buildWaveformBlockCache({
			buffer: fakeBuffer([data]),
			blockSize: 4,
		});
		expect(cache.length).toBe(3);
		expect(cache[2]).toBe(1);
	});
});

describe("extractPeaksFromBlockCache", () => {
	it("places an impulse in the same column as the raw-sample path (within block smear)", () => {
		const data = new Float32Array(6400);
		data[3200] = 1;
		const buffer = fakeBuffer([data]);
		const blockSize = 64;
		const cache = buildWaveformBlockCache({ buffer, blockSize });

		const raw = extractRmsRange({
			buffer,
			count: 100,
			startSample: 0,
			endSample: 6400,
			globalMax: 1,
		});
		const cached = extractPeaksFromBlockCache({
			blockMax: cache,
			blockSize,
			count: 100,
			startSample: 0,
			endSample: 6400,
			globalMax: 1,
		});

		const rawCol = raw.findIndex((v) => v > 0.9);
		const cachedCol = cached.findIndex((v) => v > 0.9);
		expect(rawCol).toBe(50);
		// Block granularity may light up at most one adjacent column.
		expect(Math.abs(cachedCol - rawCol)).toBeLessThanOrEqual(1);
	});

	it("respects startSample windows (trimmed clips)", () => {
		const data = new Float32Array(6400);
		data[3200] = 1;
		const buffer = fakeBuffer([data]);
		const blockSize = 64;
		const cache = buildWaveformBlockCache({ buffer, blockSize });

		// Window that EXCLUDES the impulse → silence everywhere.
		const silent = extractPeaksFromBlockCache({
			blockMax: cache,
			blockSize,
			count: 10,
			startSample: 0,
			endSample: 3072,
			globalMax: 1,
		});
		expect(Math.max(...silent)).toBe(0);

		// Window that starts right at the impulse → first column hot.
		const hot = extractPeaksFromBlockCache({
			blockMax: cache,
			blockSize,
			count: 10,
			startSample: 3200,
			endSample: 6400,
			globalMax: 1,
		});
		expect(hot[0]).toBeGreaterThan(0.9);
	});

	it("normalizes by globalMax and clamps to 1", () => {
		const data = new Float32Array(64);
		data[0] = 0.5;
		const cache = buildWaveformBlockCache({
			buffer: fakeBuffer([data]),
			blockSize: 64,
		});
		const peaks = extractPeaksFromBlockCache({
			blockMax: cache,
			blockSize: 64,
			count: 1,
			startSample: 0,
			endSample: 64,
			globalMax: 0.25,
		});
		expect(peaks[0]).toBe(1);
	});

	it("returns zeros for an empty range", () => {
		const cache = new Float32Array([1, 1]);
		const peaks = extractPeaksFromBlockCache({
			blockMax: cache,
			blockSize: 64,
			count: 5,
			startSample: 100,
			endSample: 100,
			globalMax: 1,
		});
		expect(peaks).toEqual([0, 0, 0, 0, 0]);
	});
});
