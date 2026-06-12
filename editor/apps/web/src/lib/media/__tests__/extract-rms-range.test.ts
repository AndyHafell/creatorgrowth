import { describe, expect, it } from "bun:test";
import { extractRmsRange } from "../rms";

// Minimal AudioBuffer stand-in — extractRmsRange only touches these members.
function fakeBuffer(data: Float32Array): AudioBuffer {
	return {
		numberOfChannels: 1,
		length: data.length,
		getChannelData: () => data,
	} as unknown as AudioBuffer;
}

describe("extractRmsRange", () => {
	// The Raw Cut zoom bug: with a FLOORED per-column step, the truncation error
	// accumulates across columns, so the drawn waveform drifts left/right against
	// the (correctly linear) red/green bands — worse the bigger the fractional
	// part of rangeLength/count, i.e. it comes and goes with zoom level.
	it("maps an impulse to its true column when rangeLength/count is fractional", () => {
		const data = new Float32Array(199);
		data[150] = 1; // impulse at sample 150 of [0, 199)
		const peaks = extractRmsRange({
			buffer: fakeBuffer(data),
			count: 100,
			startSample: 0,
			endSample: 199,
			globalMax: 1,
		});
		// True column = floor(150 / (199/100)) = 75. The floored-step bug reads
		// only samples 0..99 (step=1), so the impulse vanished entirely.
		expect(peaks[75]).toBeGreaterThan(0.9);
	});

	it("covers the very end of the range with the last column", () => {
		const data = new Float32Array(199);
		data[198] = 1;
		const peaks = extractRmsRange({
			buffer: fakeBuffer(data),
			count: 100,
			startSample: 0,
			endSample: 199,
			globalMax: 1,
		});
		expect(peaks[99]).toBeGreaterThan(0.9);
	});

	it("keeps exact integer binning unchanged", () => {
		const data = new Float32Array(200);
		data[100] = 1; // column 50 of 100 (step exactly 2)
		const peaks = extractRmsRange({
			buffer: fakeBuffer(data),
			count: 100,
			startSample: 0,
			endSample: 200,
			globalMax: 1,
		});
		expect(peaks[50]).toBeGreaterThan(0.9);
	});
});
