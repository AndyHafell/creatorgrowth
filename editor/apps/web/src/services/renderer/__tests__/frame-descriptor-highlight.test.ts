import { describe, expect, mock, test } from "bun:test";

// frame-descriptor needs canvas APIs that don't exist under bun — stub them.
function fakeCanvas({ width, height }: { width: number; height: number }) {
	const ctx = {
		fillStyle: "",
		strokeStyle: "",
		lineWidth: 0,
		clearRect() {},
		fillRect() {},
		beginPath() {},
		fill() {},
		stroke() {},
		roundRect() {},
		drawImage() {},
		save() {},
		restore() {},
		translate() {},
		rotate() {},
		scale() {},
	};
	return { width, height, getContext: () => ctx };
}

mock.module("../canvas-utils", () => ({
	createOffscreenCanvas: fakeCanvas,
}));
mock.module("opencut-wasm", () => ({
	mediaTimeToSeconds: ({ time }: { time: number }) => time / 705_600_000,
	secondsToMediaTime: ({ time }: { time: number }) => time * 705_600_000,
	TICKS_PER_SECOND: () => 705_600_000,
}));

import type { CanvasRenderer } from "../canvas-renderer";

const { buildFrameDescriptor } = await import("../compositor/frame-descriptor");
const { EffectLayerNode } = await import("../nodes/effect-layer-node");
const { RootNode } = await import("../nodes/root-node");
const { VideoNode } = await import("../nodes/video-node");
type VideoNodeParams = ConstructorParameters<typeof VideoNode>[0];

const renderer = { width: 1920, height: 1080 } as CanvasRenderer;

function makeResolvedVideo() {
	const video = new VideoNode({
		duration: 1000,
		timeOffset: 0,
		trimStart: 0,
		trimEnd: 0,
		transform: { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1,
		effects: [],
		masks: [],
	} as unknown as VideoNodeParams);
	video.resolved = {
		localTime: 100,
		transform: { scaleX: 1, scaleY: 1, position: { x: 0, y: 0 }, rotate: 0 },
		opacity: 1,
		effectPasses: [],
		source: fakeCanvas({
			width: 1920,
			height: 1080,
		}) as unknown as OffscreenCanvas,
		sourceWidth: 1920,
		sourceHeight: 1080,
	};
	return video;
}

function makeResolvedHighlight() {
	const node = new EffectLayerNode({
		effectType: "magic-highlight",
		effectParams: {},
		timeOffset: 0,
		duration: 1000,
	});
	node.resolved = {
		passes: [],
		highlight: {
			region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
			size: 0.65,
			progress: 1,
			dim: 0.7,
			blurIntensity: 25,
			cornerRadius: 12,
		},
	};
	return node;
}

function makeResolvedZoom() {
	const node = new EffectLayerNode({
		effectType: "magic-zoom",
		effectParams: {},
		timeOffset: 0,
		duration: 1000,
	});
	node.resolved = {
		passes: [],
		camera: { scale: 2, focalX: 0.5, focalY: 0.5, progress: 1 },
	};
	return node;
}

describe("buildFrameDescriptor — magic highlight", () => {
	test("highlight above video emits blur + dim + masked cutout", async () => {
		const root = new RootNode({ duration: 1000 });
		root.add(makeResolvedVideo());
		root.add(makeResolvedHighlight());

		const { frame, textures } = await buildFrameDescriptor({
			node: root,
			renderer,
		});

		const kinds = frame.items.map((item) =>
			item.type === "layer" ? `layer${item.mask ? "+mask" : ""}` : item.type,
		);
		expect(kinds).toEqual([
			"layer", // the video itself
			"sceneEffect", // background blur
			"layer", // dim quad
			"layer+mask", // the cutout
		]);

		const cutout = frame.items[3];
		if (cutout.type !== "layer") throw new Error("expected layer");
		// pop scale at progress 1 for a 50% region at 65% size = 1.3
		expect(cutout.transform.width).toBeCloseTo(1920 * 1.3);
		expect(cutout.mask?.textureId).toContain("hl-mask");

		const textureIds = textures.map((t) => t.id);
		expect(textureIds.some((id) => id.includes("hl-dim"))).toBe(true);
		expect(textureIds.some((id) => id.includes("hl-mask"))).toBe(true);

		// Rust serde quirk: FrameItemDescriptor's enum rename_all camelCases the
		// variant TAG but not struct-variant FIELDS — sceneEffect items must also
		// carry snake_case effect_pass_groups or the whole frame is rejected
		// ("missing field `effect_pass_groups`", the original Magic Highlighter bug).
		const sceneEffect = frame.items[1] as Record<string, unknown>;
		expect(sceneEffect.effect_pass_groups).toEqual(
			sceneEffect.effectPassGroups,
		);
		expect(Array.isArray(sceneEffect.effect_pass_groups)).toBe(true);
	});

	test("zoom camera scales the video layer below it (control)", async () => {
		const root = new RootNode({ duration: 1000 });
		root.add(makeResolvedVideo());
		root.add(makeResolvedZoom());

		const { frame } = await buildFrameDescriptor({ node: root, renderer });
		const video = frame.items[0];
		if (video.type !== "layer") throw new Error("expected layer");
		expect(video.transform.width).toBeCloseTo(1920 * 2);
		expect(video.transform.centerX).toBeCloseTo(960);
	});

	test("highlight BELOW the video emits nothing useful (ordering regression guard)", async () => {
		const root = new RootNode({ duration: 1000 });
		root.add(makeResolvedHighlight());
		root.add(makeResolvedVideo());

		const { frame } = await buildFrameDescriptor({ node: root, renderer });
		// blur+dim land before the video layer, cutout has no sources — the video covers everything
		const lastItem = frame.items[frame.items.length - 1];
		expect(lastItem.type).toBe("layer");
		if (lastItem.type !== "layer") throw new Error("expected layer");
		expect(lastItem.mask).toBeNull();
	});
});

describe("buildFrameDescriptor — camera spring chase (time provided)", () => {
	const TPF = Math.round(705_600_000 / 30); // one 30fps frame in ticks

	function springRenderer() {
		return {
			width: 1920,
			height: 1080,
			cameraSpring: null,
			lastCameraTimeTicks: null,
		} as unknown as CanvasRenderer;
	}

	test("first frame snaps to target; clip end chases identity; seek snaps", async () => {
		const zoom = makeResolvedZoom();
		const root = new RootNode({ duration: 1000 });
		root.add(makeResolvedVideo());
		root.add(zoom);
		const renderer2 = springRenderer();

		// frame 1: first time seen -> reset -> exactly on the 2x target
		const a = await buildFrameDescriptor({
			node: root,
			renderer: renderer2,
			time: 0,
		});
		const va = a.frame.items[0];
		if (va.type !== "layer") throw new Error("expected layer");
		expect(va.transform.width).toBeCloseTo(1920 * 2);

		// clip "ends": camera target becomes identity, spring should LAG behind
		zoom.resolved = null;
		const b = await buildFrameDescriptor({
			node: root,
			renderer: renderer2,
			time: TPF,
		});
		const vb = b.frame.items[0];
		if (vb.type !== "layer") throw new Error("expected layer");
		expect(vb.transform.width).toBeGreaterThan(1920);
		expect(vb.transform.width).toBeLessThan(1920 * 2);

		// big jump (seek) -> snap to identity, camera fully released
		const c = await buildFrameDescriptor({
			node: root,
			renderer: renderer2,
			time: TPF + 705_600_000 * 10,
		});
		const vc = c.frame.items[0];
		if (vc.type !== "layer") throw new Error("expected layer");
		expect(vc.transform.width).toBeCloseTo(1920);
	});

	test("without time, behavior is unchanged (no spring)", async () => {
		const root = new RootNode({ duration: 1000 });
		root.add(makeResolvedVideo());
		root.add(makeResolvedZoom());
		const { frame } = await buildFrameDescriptor({
			node: root,
			renderer: springRenderer(),
		});
		const video = frame.items[0];
		if (video.type !== "layer") throw new Error("expected layer");
		expect(video.transform.width).toBeCloseTo(1920 * 2);
	});
});
