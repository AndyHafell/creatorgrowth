import { describe, expect, it } from "bun:test";
import { computeWaveformSampleWindow } from "../rms";

// The Raw Cut Audio waveform bug: every trimmed clip drew peaks for the WHOLE
// source file (pixel range mapped over buffer.length), so what you saw at any
// pixel had no relation to what played there — stretches of speech rendered as
// the source's silences and vice versa. The clip's pixels must map onto the
// clip's source window [trimStart, trimStart + visibleDuration * rate].
describe("computeWaveformSampleWindow", () => {
	// 60s source at 100 samples/sec = 6000 samples.
	const source = { bufferLength: 6000, sampleRate: 100 };

	it("maps a fully-visible trimmed clip to its trim window, not the file head", () => {
		const { startSample, endSample } = computeWaveformSampleWindow({
			...source,
			trimStartSec: 30,
			visibleDurationSec: 5,
			clipLeftPx: 0,
			drawWidthPx: 500,
			fullWidthPx: 500,
		});
		// The buggy mapping returned 0..6000 (whole file). Correct: 30s..35s.
		expect(startSample).toBe(3000);
		expect(endSample).toBe(3500);
	});

	it("maps a viewport sub-slice of the clip proportionally inside the trim window", () => {
		const { startSample, endSample } = computeWaveformSampleWindow({
			...source,
			trimStartSec: 30,
			visibleDurationSec: 5,
			clipLeftPx: 100,
			drawWidthPx: 200,
			fullWidthPx: 500,
		});
		// 100/500 → 1s into the window; 300/500 → 3s in.
		expect(startSample).toBe(3100);
		expect(endSample).toBe(3300);
	});

	it("scales the source window by playbackRate", () => {
		const { startSample, endSample } = computeWaveformSampleWindow({
			...source,
			trimStartSec: 10,
			visibleDurationSec: 5,
			playbackRate: 2,
			clipLeftPx: 0,
			drawWidthPx: 500,
			fullWidthPx: 500,
		});
		// 5s of timeline at 2x consumes 10s of source.
		expect(startSample).toBe(1000);
		expect(endSample).toBe(2000);
	});

	it("clamps a window overrunning the buffer end", () => {
		const { startSample, endSample } = computeWaveformSampleWindow({
			...source,
			trimStartSec: 58,
			visibleDurationSec: 5,
			clipLeftPx: 0,
			drawWidthPx: 500,
			fullWidthPx: 500,
		});
		expect(startSample).toBe(5800);
		expect(endSample).toBe(6000);
	});

	it("returns an empty window for degenerate widths", () => {
		const { startSample, endSample } = computeWaveformSampleWindow({
			...source,
			trimStartSec: 0,
			visibleDurationSec: 5,
			clipLeftPx: 0,
			drawWidthPx: 500,
			fullWidthPx: 0,
		});
		expect(endSample - startSample).toBe(0);
	});
});
