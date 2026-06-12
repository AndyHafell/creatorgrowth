import { describe, expect, it } from "bun:test";
import { coveredSeconds, scoreAgainstReference } from "../score";

const cut = (start: number, end: number) => ({
	start,
	end,
	kind: "retake",
	reason: "",
	confidence: 0.9,
});

describe("coveredSeconds", () => {
	it("sums the intersection of a span with a set of cuts (overlaps merged)", () => {
		// Two cuts overlap each other inside [0, 100]: union [10,40] = 30s.
		expect(
			coveredSeconds({ start: 10, end: 40 }, [cut(10, 30), cut(20, 40)]),
		).toBe(30);
		expect(coveredSeconds({ start: 0, end: 10 }, [cut(20, 30)])).toBe(0);
	});

	it("subtracts excluded sub-spans (allowed reference cuts inside a keep)", () => {
		// Engine cut [0,30] inside keep [0,152], but [0,18] is an allowed ref cut.
		expect(
			coveredSeconds(
				{ start: 0, end: 152 },
				[cut(0, 30)],
				[{ start: 0, end: 18 }],
			),
		).toBe(12);
	});
});

describe("scoreAgainstReference", () => {
	it("scores recall (≥50% coverage = hit) and keep violations (>3s = flag)", () => {
		const reference = {
			cuts: [
				{ start: 0, end: 18, marker: false, label: "open take 1" },
				{ start: 100, end: 120, marker: true, label: "spoken retraction" },
			],
			keeps: [
				{
					start: 200,
					end: 260,
					label: "walkthrough",
					allowed: [] as Array<{ start: number; end: number }>,
				},
			],
		};
		const engine = [cut(2, 18), cut(500, 510), cut(200, 210)];
		const card = scoreAgainstReference({ reference, engineCuts: engine });
		// ref 1: covered 16/18 ≥ 0.5 → hit; ref 2 missed (marker miss).
		expect(card.hits).toBe(1);
		expect(card.total).toBe(2);
		expect(card.markerHits).toBe(0);
		expect(card.markerTotal).toBe(1);
		expect(card.missed[0].label).toBe("spoken retraction");
		// keep violated by 10s (>3s tolerance).
		expect(card.keepViolations.length).toBe(1);
		expect(card.keepViolations[0].seconds).toBe(10);
	});
});
