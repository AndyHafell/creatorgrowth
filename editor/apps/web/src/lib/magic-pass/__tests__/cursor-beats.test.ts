import { describe, expect, test } from "bun:test";
import {
	cursorBeatCandidates,
	cursorHintLines,
	detectCursorDwells,
	DWELL_MOVE_THRESHOLD,
	MAX_DWELL_DURATION_MS,
	MIN_DWELL_DURATION_MS,
	parseCursorLog,
	rankAndSpaceDwells,
	type CursorSample,
} from "../cursor-beats";
import type { ElementWindow } from "../timeline-map";

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

/** N samples at 33ms cadence sitting still at (cx, cy), starting at timeMs. */
function still({
	fromMs,
	ms,
	cx,
	cy,
	leftButtonPressed = false,
	cursorType = null,
}: {
	fromMs: number;
	ms: number;
	cx: number;
	cy: number;
	leftButtonPressed?: boolean;
	cursorType?: "pointer" | "text" | null;
}): CursorSample[] {
	const out: CursorSample[] = [];
	for (let t = fromMs; t <= fromMs + ms; t += 33) {
		out.push({ timeMs: t, cx, cy, leftButtonPressed: false, cursorType });
	}
	// A click flag on one mid-run sample is enough to mark the dwell.
	if (leftButtonPressed && out.length > 2) {
		out[Math.floor(out.length / 2)].leftButtonPressed = true;
	}
	return out;
}

/** A fast diagonal move that breaks any dwell run. */
function sweep({ fromMs, ms }: { fromMs: number; ms: number }): CursorSample[] {
	const out: CursorSample[] = [];
	const steps = Math.max(2, Math.floor(ms / 33));
	for (let i = 0; i < steps; i++) {
		out.push({
			timeMs: fromMs + i * 33,
			cx: 0.1 + (0.8 * i) / steps,
			cy: 0.1 + (0.8 * i) / steps,
			leftButtonPressed: false,
			cursorType: null,
		});
	}
	return out;
}

describe("parseCursorLog", () => {
	test("parses sample lines and skips the header", () => {
		const ndjson = [
			'{"type":"header","version":1,"startEpochMs":1718000000000,"sampleIntervalMs":33}',
			'{"type":"sample","timeMs":0,"cx":0.5,"cy":0.5,"leftButtonPressed":false,"cursorType":null}',
			'{"type":"sample","timeMs":33,"cx":0.51,"cy":0.5,"leftButtonPressed":true,"cursorType":"pointer"}',
		].join("\n");
		const samples = parseCursorLog(ndjson);
		expect(samples.length).toBe(2);
		expect(samples[0]).toEqual({
			timeMs: 0,
			cx: 0.5,
			cy: 0.5,
			leftButtonPressed: false,
			cursorType: null,
		});
		expect(samples[1].leftButtonPressed).toBe(true);
		expect(samples[1].cursorType).toBe("pointer");
	});

	test("derives timeMs from epoch timestampMs when header gives startEpochMs", () => {
		// The raw OpenScreen helper emits epoch timestampMs, not relative timeMs.
		const ndjson = [
			'{"type":"header","version":1,"startEpochMs":1000}',
			'{"type":"sample","timestampMs":1033,"cx":0.2,"cy":0.3}',
		].join("\n");
		const samples = parseCursorLog(ndjson);
		expect(samples.length).toBe(1);
		expect(samples[0].timeMs).toBe(33);
	});

	test("skips malformed lines, non-finite values, and clamps cx/cy to 0-1", () => {
		const ndjson = [
			"not json at all",
			'{"type":"sample","timeMs":0,"cx":1.4,"cy":-0.2}',
			'{"type":"sample","timeMs":"NaN","cx":0.5,"cy":0.5}',
			'{"type":"ready","timestampMs":5}',
			"",
		].join("\n");
		const samples = parseCursorLog(ndjson);
		expect(samples.length).toBe(1);
		expect(samples[0].cx).toBe(1);
		expect(samples[0].cy).toBe(0);
	});

	test("sorts samples by timeMs", () => {
		const ndjson = [
			'{"type":"sample","timeMs":66,"cx":0.5,"cy":0.5}',
			'{"type":"sample","timeMs":0,"cx":0.5,"cy":0.5}',
		].join("\n");
		const samples = parseCursorLog(ndjson);
		expect(samples.map((s) => s.timeMs)).toEqual([0, 66]);
	});
});

describe("detectCursorDwells", () => {
	test("finds a dwell where the cursor sits still for ~1s", () => {
		const samples = [
			...sweep({ fromMs: 0, ms: 500 }),
			...still({ fromMs: 600, ms: 1000, cx: 0.4, cy: 0.6 }),
			...sweep({ fromMs: 1700, ms: 500 }),
		];
		const dwells = detectCursorDwells(samples);
		expect(dwells.length).toBe(1);
		expect(dwells[0].cx).toBeCloseTo(0.4, 2);
		expect(dwells[0].cy).toBeCloseTo(0.6, 2);
		expect(dwells[0].centerTimeMs).toBeGreaterThan(900);
		expect(dwells[0].centerTimeMs).toBeLessThan(1300);
		expect(dwells[0].durationMs).toBeGreaterThanOrEqual(MIN_DWELL_DURATION_MS);
	});

	test("ignores runs shorter than the minimum dwell duration", () => {
		const samples = [
			...sweep({ fromMs: 0, ms: 500 }),
			...still({ fromMs: 600, ms: MIN_DWELL_DURATION_MS - 150, cx: 0.4, cy: 0.6 }),
			...sweep({ fromMs: 1000, ms: 500 }),
		];
		expect(detectCursorDwells(samples).length).toBe(0);
	});

	test("ignores parked-mouse runs longer than the maximum dwell duration", () => {
		const samples = [
			...sweep({ fromMs: 0, ms: 300 }),
			...still({ fromMs: 400, ms: MAX_DWELL_DURATION_MS + 1000, cx: 0.4, cy: 0.6 }),
			...sweep({ fromMs: MAX_DWELL_DURATION_MS + 1500, ms: 300 }),
		];
		expect(detectCursorDwells(samples).length).toBe(0);
	});

	test("small jitter inside the move threshold still counts as one dwell", () => {
		const base = still({ fromMs: 0, ms: 1000, cx: 0.5, cy: 0.5 });
		const jittered = base.map((s, i) => ({
			...s,
			cx: s.cx + (i % 2 === 0 ? 1 : -1) * (DWELL_MOVE_THRESHOLD * 0.4),
		}));
		const dwells = detectCursorDwells([
			...sweep({ fromMs: -500, ms: 400 }),
			...jittered,
			...sweep({ fromMs: 1100, ms: 400 }),
		]);
		expect(dwells.length).toBe(1);
	});

	test("flags dwells containing a click and dwells over a clickable", () => {
		const samples = [
			...still({
				fromMs: 0,
				ms: 1000,
				cx: 0.2,
				cy: 0.2,
				leftButtonPressed: true,
			}),
			...sweep({ fromMs: 1100, ms: 600 }),
			...still({
				fromMs: 1800,
				ms: 1000,
				cx: 0.8,
				cy: 0.8,
				cursorType: "pointer",
			}),
			...sweep({ fromMs: 2900, ms: 600 }),
			...still({ fromMs: 3600, ms: 1000, cx: 0.5, cy: 0.5 }),
		];
		const dwells = detectCursorDwells(samples);
		expect(dwells.length).toBe(3);
		expect(dwells[0].hasClick).toBe(true);
		expect(dwells[1].overClickable).toBe(true);
		expect(dwells[2].hasClick).toBe(false);
		expect(dwells[2].overClickable).toBe(false);
	});

	test("returns empty for fewer than 2 samples", () => {
		expect(detectCursorDwells([])).toEqual([]);
		expect(
			detectCursorDwells([{ timeMs: 0, cx: 0.5, cy: 0.5 }]),
		).toEqual([]);
	});
});

describe("rankAndSpaceDwells", () => {
	test("drops the weaker of two dwells closer than the spacing", () => {
		const strong = {
			centerTimeMs: 1000,
			startTimeMs: 0,
			endTimeMs: 2000,
			cx: 0.5,
			cy: 0.5,
			durationMs: 2000,
			hasClick: false,
			overClickable: false,
		};
		const weak = { ...strong, centerTimeMs: 2200, durationMs: 600 };
		const out = rankAndSpaceDwells([weak, strong]);
		expect(out.length).toBe(1);
		expect(out[0].centerTimeMs).toBe(1000);
	});

	test("keeps dwells spaced beyond the minimum and returns them in time order", () => {
		const a = {
			centerTimeMs: 5000,
			startTimeMs: 4500,
			endTimeMs: 5500,
			cx: 0.5,
			cy: 0.5,
			durationMs: 1000,
			hasClick: false,
			overClickable: false,
		};
		const b = { ...a, centerTimeMs: 1000, durationMs: 2000 };
		const out = rankAndSpaceDwells([a, b]);
		expect(out.map((d) => d.centerTimeMs)).toEqual([1000, 5000]);
	});
});

describe("cursorBeatCandidates", () => {
	// Media [0,10) at timeline [0,10), media [20,30) at timeline [10,20).
	const elements = [
		el({ startSec: 0, trimStartSec: 0, durSec: 10 }),
		el({ startSec: 10, trimStartSec: 20, durSec: 10 }),
	];

	const dwell = {
		centerTimeMs: 5000,
		startTimeMs: 4500,
		endTimeMs: 5500,
		cx: 0.42,
		cy: 0.61,
		durationMs: 1000,
		hasClick: false,
		overClickable: false,
	};

	test("converts a dwell into a zoom BeatCandidate with percent focal", () => {
		const out = cursorBeatCandidates({
			dwells: [dwell],
			elements,
			ticksPerSecond: TPS,
		});
		expect(out.length).toBe(1);
		expect(out[0].kind).toBe("zoom");
		expect(out[0].triggerStart).toBeCloseTo(4.5, 2);
		expect(out[0].triggerEnd).toBeCloseTo(5.5, 2);
		expect(out[0].focalHint).toEqual({ x: 42, y: 61 });
		expect(out[0].strength).toBe(1);
	});

	test("strength 2 for a dwell with a click or over a clickable", () => {
		const out = cursorBeatCandidates({
			dwells: [
				{ ...dwell, hasClick: true },
				{ ...dwell, centerTimeMs: 8000, startTimeMs: 7500, endTimeMs: 8500, overClickable: true },
			],
			elements,
			ticksPerSecond: TPS,
		});
		expect(out.map((c) => c.strength)).toEqual([2, 2]);
	});

	test("maps media time through cuts and drops dwells in cut content", () => {
		const out = cursorBeatCandidates({
			dwells: [
				{ ...dwell, centerTimeMs: 25000, startTimeMs: 24500, endTimeMs: 25500 },
				{ ...dwell, centerTimeMs: 15000, startTimeMs: 14500, endTimeMs: 15500 },
			],
			elements,
			ticksPerSecond: TPS,
		});
		// 25s media → 15s timeline; the 15s-media dwell sits in the cut.
		expect(out.length).toBe(1);
		expect(out[0].triggerStart).toBeCloseTo(14.5, 2);
	});
});

describe("cursorHintLines", () => {
	const cand = {
		kind: "zoom" as const,
		triggerStart: 12.3,
		triggerEnd: 13.1,
		reason: "cursor dwell",
		focalHint: { x: 42, y: 61 },
		strength: 2,
	};

	test("formats hint lines for candidates inside the window", () => {
		const lines = cursorHintLines({
			candidates: [cand, { ...cand, triggerStart: 200, triggerEnd: 201 }],
			scopeStart: 0,
			scopeEnd: 120,
		});
		expect(lines.length).toBe(1);
		expect(lines[0]).toContain("12.3");
		expect(lines[0]).toContain("(42, 61)");
	});

	test("empty input gives empty output", () => {
		expect(
			cursorHintLines({ candidates: [], scopeStart: 0, scopeEnd: 120 }),
		).toEqual([]);
	});
});
