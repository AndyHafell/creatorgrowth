import { describe, expect, test } from "bun:test";
import { magicHighlightEffectDefinition } from "../definitions/magic-highlight";
import { magicZoomEffectDefinition } from "../definitions/magic-zoom";

const TPS = 10; // tests use a simple tick rate

function defaults(def: {
	params: ReadonlyArray<{ key: string; default: unknown }>;
}): Record<string, number | string | boolean> {
	return Object.fromEntries(
		def.params.map((p) => [p.key, p.default]),
	) as Record<string, number | string | boolean>;
}

describe("magic-zoom definition", () => {
	test("kind camera, no passes", () => {
		expect(magicZoomEffectDefinition.kind).toBe("camera");
		expect(magicZoomEffectDefinition.renderer.passes).toHaveLength(0);
	});

	test("in-out: identity at edges, target scale mid-clip", () => {
		const effectParams = {
			...defaults(magicZoomEffectDefinition),
			scale: 2,
			easeIn: 1,
			easeOut: 1,
		};
		const resolve = magicZoomEffectDefinition.resolveCamera;
		if (!resolve) throw new Error("resolveCamera missing");
		const dur = 100; // 10s at TPS=10
		expect(
			resolve({
				effectParams,
				localTime: 0,
				duration: dur,
				ticksPerSecond: TPS,
			}),
		).toBeNull(); // identity -> null (no camera work needed)
		expect(
			resolve({
				effectParams,
				localTime: 50,
				duration: dur,
				ticksPerSecond: TPS,
			})?.scale,
		).toBeCloseTo(2);
		expect(
			resolve({
				effectParams,
				localTime: 100,
				duration: dur,
				ticksPerSecond: TPS,
			}),
		).toBeNull();
	});

	test("focal percent params map to 0-1", () => {
		const effectParams = {
			...defaults(magicZoomEffectDefinition),
			focalX: 75,
			focalY: 25,
		};
		const cam = magicZoomEffectDefinition.resolveCamera?.({
			effectParams,
			localTime: 50,
			duration: 100,
			ticksPerSecond: TPS,
		});
		if (!cam) throw new Error("expected camera");
		expect(cam.focalX).toBeCloseTo(0.75);
		expect(cam.focalY).toBeCloseTo(0.25);
	});
});

describe("magic-highlight definition", () => {
	test("kind highlight, progress envelope hits 0/1/0", () => {
		const effectParams = {
			...defaults(magicHighlightEffectDefinition),
			transition: 1,
		};
		const resolve = magicHighlightEffectDefinition.resolveHighlight;
		if (!resolve) throw new Error("resolveHighlight missing");
		const dur = 100;
		expect(
			resolve({
				effectParams,
				localTime: 0,
				duration: dur,
				ticksPerSecond: TPS,
			})?.progress,
		).toBeCloseTo(0);
		expect(
			resolve({
				effectParams,
				localTime: 50,
				duration: dur,
				ticksPerSecond: TPS,
			})?.progress,
		).toBeCloseTo(1);
		expect(
			resolve({
				effectParams,
				localTime: 100,
				duration: dur,
				ticksPerSecond: TPS,
			})?.progress,
		).toBeCloseTo(0);
	});

	test("region percent params normalize", () => {
		const effectParams = {
			...defaults(magicHighlightEffectDefinition),
			regionX: 10,
			regionY: 20,
			regionW: 30,
			regionH: 40,
		};
		const hl = magicHighlightEffectDefinition.resolveHighlight?.({
			effectParams,
			localTime: 50,
			duration: 100,
			ticksPerSecond: TPS,
		});
		if (!hl) throw new Error("expected highlight");
		expect(hl.region.x).toBeCloseTo(0.1);
		expect(hl.region.y).toBeCloseTo(0.2);
		expect(hl.region.w).toBeCloseTo(0.3);
		expect(hl.region.h).toBeCloseTo(0.4);
	});
});

describe("magic-reframe definition", () => {
	test("constant camera at full progress for the whole clip", async () => {
		const { magicReframeEffectDefinition } = await import(
			"../definitions/magic-reframe"
		);
		const resolve = magicReframeEffectDefinition.resolveCamera;
		if (!resolve) throw new Error("resolveCamera missing");
		const effectParams = { scale: 3, focalX: 17, focalY: 50 };
		for (const localTime of [0, 1, 50, 99, 100]) {
			const cam = resolve({
				effectParams,
				localTime,
				duration: 100,
				ticksPerSecond: TPS,
			});
			if (!cam) throw new Error("expected camera");
			expect(cam.progress).toBe(1);
			expect(cam.scale).toBeCloseTo(3);
			expect(cam.focalX).toBeCloseTo(0.17);
		}
	});

	test("scale 1 resolves to null (no-op framing)", async () => {
		const { magicReframeEffectDefinition } = await import(
			"../definitions/magic-reframe"
		);
		const cam = magicReframeEffectDefinition.resolveCamera?.({
			effectParams: { scale: 1, focalX: 50, focalY: 50 },
			localTime: 50,
			duration: 100,
			ticksPerSecond: TPS,
		});
		expect(cam).toBeNull();
	});
});
