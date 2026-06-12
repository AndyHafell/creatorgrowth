import { describe, expect, test } from "bun:test";
import {
	mapWordsToTimeline,
	mediaSecToTimelineSec,
	timelineSecToMediaSec,
	type ElementWindow,
} from "../timeline-map";

// Same tick rate the wasm exports — passed in explicitly so these tests never
// load opencut-wasm (which fails under bun).
const TPS = 705_600_000;

function el({
	startSec,
	trimStartSec,
	durSec,
}: {
	startSec: number;
	trimStartSec: number;
	durSec: number;
}): ElementWindow {
	return {
		startTime: startSec * TPS,
		trimStart: trimStartSec * TPS,
		trimEnd: 0,
		duration: durSec * TPS,
	};
}

describe("mapWordsToTimeline", () => {
	test("identity mapping for an untrimmed element at t=0", () => {
		const elements = [el({ startSec: 0, trimStartSec: 0, durSec: 60 })];
		const words = [{ text: "hello", start: 1.0, end: 1.4 }];
		const out = mapWordsToTimeline({ words, elements, ticksPerSecond: TPS });
		expect(out.length).toBe(1);
		expect(out[0].text).toBe("hello");
		expect(out[0].start).toBeCloseTo(1.0, 3);
		expect(out[0].end).toBeCloseTo(1.4, 3);
	});

	test("offsets by startTime and trimStart", () => {
		// Element placed at timeline 10s, showing media from 30s.
		const elements = [el({ startSec: 10, trimStartSec: 30, durSec: 20 })];
		const words = [{ text: "word", start: 31, end: 31.5 }];
		const out = mapWordsToTimeline({ words, elements, ticksPerSecond: TPS });
		expect(out.length).toBe(1);
		expect(out[0].start).toBeCloseTo(11, 3);
		expect(out[0].end).toBeCloseTo(11.5, 3);
	});

	test("drops words that were cut out, maps words after the cut", () => {
		// Media [0,10) at timeline [0,10), media [20,30) at timeline [10,20).
		const elements = [
			el({ startSec: 0, trimStartSec: 0, durSec: 10 }),
			el({ startSec: 10, trimStartSec: 20, durSec: 10 }),
		];
		const words = [
			{ text: "kept-early", start: 5, end: 5.3 },
			{ text: "cut", start: 15, end: 15.3 },
			{ text: "kept-late", start: 25, end: 25.3 },
		];
		const out = mapWordsToTimeline({ words, elements, ticksPerSecond: TPS });
		expect(out.map((w) => w.text)).toEqual(["kept-early", "kept-late"]);
		expect(out[1].start).toBeCloseTo(15, 3);
	});

	test("clamps a word that straddles the end of its element window", () => {
		const elements = [el({ startSec: 0, trimStartSec: 0, durSec: 10 })];
		const words = [{ text: "edge", start: 9.8, end: 10.6 }];
		const out = mapWordsToTimeline({ words, elements, ticksPerSecond: TPS });
		expect(out.length).toBe(1);
		expect(out[0].end).toBeCloseTo(10, 3);
	});

	test("handles unsorted element lists", () => {
		const elements = [
			el({ startSec: 10, trimStartSec: 20, durSec: 10 }),
			el({ startSec: 0, trimStartSec: 0, durSec: 10 }),
		];
		const words = [{ text: "late", start: 25, end: 25.2 }];
		const out = mapWordsToTimeline({ words, elements, ticksPerSecond: TPS });
		expect(out.length).toBe(1);
		expect(out[0].start).toBeCloseTo(15, 3);
	});
});

describe("timelineSecToMediaSec", () => {
	const elements = [
		el({ startSec: 0, trimStartSec: 0, durSec: 10 }),
		el({ startSec: 10, trimStartSec: 20, durSec: 10 }),
	];

	test("maps timeline time inside the second segment back to media time", () => {
		expect(
			timelineSecToMediaSec({ timelineSec: 15, elements, ticksPerSecond: TPS }),
		).toBeCloseTo(25, 3);
	});

	test("maps timeline time in the first segment", () => {
		expect(
			timelineSecToMediaSec({ timelineSec: 5, elements, ticksPerSecond: TPS }),
		).toBeCloseTo(5, 3);
	});

	test("returns null outside any element", () => {
		expect(
			timelineSecToMediaSec({ timelineSec: 25, elements, ticksPerSecond: TPS }),
		).toBeNull();
	});
});

describe("mediaSecToTimelineSec", () => {
	// Media [0,10) at timeline [0,10), media [20,30) at timeline [10,20).
	const elements = [
		el({ startSec: 0, trimStartSec: 0, durSec: 10 }),
		el({ startSec: 10, trimStartSec: 20, durSec: 10 }),
	];

	test("identity mapping inside the first segment", () => {
		expect(
			mediaSecToTimelineSec({ mediaSec: 5, elements, ticksPerSecond: TPS }),
		).toBeCloseTo(5, 3);
	});

	test("maps media time inside the second segment onto the timeline", () => {
		expect(
			mediaSecToTimelineSec({ mediaSec: 25, elements, ticksPerSecond: TPS }),
		).toBeCloseTo(15, 3);
	});

	test("returns null for media time that was cut out", () => {
		expect(
			mediaSecToTimelineSec({ mediaSec: 15, elements, ticksPerSecond: TPS }),
		).toBeNull();
	});

	test("round-trips with timelineSecToMediaSec", () => {
		const media = timelineSecToMediaSec({
			timelineSec: 13.7,
			elements,
			ticksPerSecond: TPS,
		});
		expect(media).not.toBeNull();
		expect(
			mediaSecToTimelineSec({
				mediaSec: media as number,
				elements,
				ticksPerSecond: TPS,
			}),
		).toBeCloseTo(13.7, 3);
	});
});
