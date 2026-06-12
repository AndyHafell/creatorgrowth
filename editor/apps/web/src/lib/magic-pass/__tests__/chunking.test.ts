import { describe, expect, test } from "bun:test";
import { mergeAdjacentReframes, splitScopeIntoChunks } from "../chunking";
import type { MagicPlanClip } from "../types";

function clip(over: Partial<MagicPlanClip> = {}): MagicPlanClip {
	return {
		kind: "reframe",
		start: 0,
		end: 5,
		scale: 1.3,
		focalX: 50,
		focalY: 50,
		easeIn: 0,
		easeOut: 0,
		reason: "resting",
		...over,
	};
}

function expectContiguousCover(
	chunks: Array<{ start: number; end: number }>,
	scopeStart: number,
	scopeEnd: number,
) {
	expect(chunks.length).toBeGreaterThan(0);
	expect(chunks[0].start).toBeCloseTo(scopeStart, 5);
	expect(chunks[chunks.length - 1].end).toBeCloseTo(scopeEnd, 5);
	for (let i = 1; i < chunks.length; i++) {
		expect(chunks[i].start).toBeCloseTo(chunks[i - 1].end, 5);
	}
}

describe("splitScopeIntoChunks", () => {
	test("scope shorter than target stays one chunk", () => {
		const chunks = splitScopeIntoChunks({ scopeStart: 0, scopeEnd: 100 });
		expect(chunks).toEqual([{ start: 0, end: 100 }]);
	});

	test("13-minute scope splits into ~135s contiguous chunks", () => {
		const chunks = splitScopeIntoChunks({ scopeStart: 0, scopeEnd: 780 });
		expect(chunks.length).toBe(6);
		expectContiguousCover(chunks, 0, 780);
		for (const c of chunks) {
			expect(c.end - c.start).toBeGreaterThan(100);
			expect(c.end - c.start).toBeLessThan(160);
		}
	});

	test("cuts snap to a nearby boundary", () => {
		const chunks = splitScopeIntoChunks({
			scopeStart: 0,
			scopeEnd: 270,
			boundaries: [141.2],
		});
		expect(chunks.length).toBe(2);
		expect(chunks[0].end).toBeCloseTo(141.2, 5);
		expect(chunks[1].start).toBeCloseTo(141.2, 5);
	});

	test("a boundary too far from the even cut is ignored", () => {
		const chunks = splitScopeIntoChunks({
			scopeStart: 0,
			scopeEnd: 270,
			boundaries: [40, 230],
		});
		expect(chunks.length).toBe(2);
		expect(chunks[0].end).toBeCloseTo(135, 5);
	});

	test("empty or inverted scope yields no chunks", () => {
		expect(splitScopeIntoChunks({ scopeStart: 10, scopeEnd: 10 })).toEqual([]);
		expect(splitScopeIntoChunks({ scopeStart: 20, scopeEnd: 10 })).toEqual([]);
	});

	test("very long scopes cap the chunk count by widening chunks", () => {
		const chunks = splitScopeIntoChunks({
			scopeStart: 0,
			scopeEnd: 3600,
			maxChunks: 12,
		});
		expect(chunks.length).toBeLessThanOrEqual(12);
		expectContiguousCover(chunks, 0, 3600);
	});
});

describe("mergeAdjacentReframes", () => {
	test("contiguous reframes with the same framing merge into one hold", () => {
		const merged = mergeAdjacentReframes([
			clip({ start: 0, end: 6, scale: 1.3, focalX: 50, focalY: 50 }),
			clip({ start: 6, end: 13, scale: 1.3, focalX: 50, focalY: 50 }),
		]);
		expect(merged.length).toBe(1);
		expect(merged[0].start).toBe(0);
		expect(merged[0].end).toBe(13);
	});

	test("different framing does not merge", () => {
		const merged = mergeAdjacentReframes([
			clip({ start: 0, end: 6, scale: 1.3 }),
			clip({ start: 6, end: 13, scale: 1.8 }),
		]);
		expect(merged.length).toBe(2);
	});

	test("near-identical framing within tolerance merges", () => {
		const merged = mergeAdjacentReframes(
			[
				clip({ start: 0, end: 6, scale: 1.3, focalX: 50 }),
				clip({ start: 6, end: 13, scale: 1.32, focalX: 51 }),
			],
			{ scaleEps: 0.05, focalEps: 2 },
		);
		expect(merged.length).toBe(1);
	});

	test("zoom and highlight clips never merge", () => {
		const merged = mergeAdjacentReframes([
			clip({ kind: "zoom", start: 0, end: 3, scale: 2 }),
			clip({ kind: "zoom", start: 3, end: 6, scale: 2 }),
		]);
		expect(merged.length).toBe(2);
	});

	test("a time gap between reframes prevents merging", () => {
		const merged = mergeAdjacentReframes([
			clip({ start: 0, end: 6 }),
			clip({ start: 8, end: 13 }),
		]);
		expect(merged.length).toBe(2);
	});
});
