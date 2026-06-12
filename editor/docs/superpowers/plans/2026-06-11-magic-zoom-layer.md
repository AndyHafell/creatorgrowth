# Magic Zoom Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Magic Zoom + Magic Highlighter adjustment-layer clips on the effect track, working in preview and export, with an interactive region overlay on the previewer.

**Architecture:** Zoom clips resolve to a *camera* (uniform scale + offset) that the frame-descriptor builder applies to the quad transform of every layer below the clip — GPU resamples source textures, stays sharp, zero Rust changes. Highlighter emits, from existing primitives: a gaussian-blur `sceneEffect` over the composite below + a black dim quad + re-emitted lower layers with a cutout camera and a rounded-rect canvas mask. Spec: `docs/superpowers/specs/2026-06-11-hyperedit-layer-design.md`.

**Tech stack:** Next.js app in `apps/web`, bun test, existing WASM compositor (untouched), zustand stores, existing effects registry.

**Conventions that bite:**
- All timeline times are **ticks** (`TICKS_PER_SECOND` from `@/lib/wasm`). User-facing ease params are seconds — convert at resolve time.
- Never `git add -A` (shared worktree). Stage exact paths only.
- DO NOT touch `lib/raw-cut/`, `app/api/final-pass/`, `components/editor/raw-cut/`, `components/editor/final-pass/`.
- Pre-existing failures to ignore: `detection-knobs.tsx` a11y lint; `opencut-wasm` load failure under `bun test` (test files that import the wasm package transitively will fail for that reason — keep new tests free of wasm imports; pure modules only).

---

### Task 1: Camera math module (pure, TDD)

**Files:**
- Create: `apps/web/src/lib/effects/camera.ts`
- Test: `apps/web/src/lib/effects/__tests__/camera.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/web/src/lib/effects/__tests__/camera.test.ts
import { describe, expect, test } from "bun:test";
import {
	applyCameraToQuad,
	cameraQuadForZoom,
	easeValue,
	highlightLayout,
	inOutEnvelope,
	zoomEnvelopeScale,
} from "../camera";

const W = 1920;
const H = 1080;

describe("cameraQuadForZoom", () => {
	test("identity at scale 1", () => {
		const q = cameraQuadForZoom({ scale: 1, focalX: 0.5, focalY: 0.5, canvasWidth: W, canvasHeight: H });
		expect(q.scale).toBe(1);
		expect(q.offsetX).toBe(0);
		expect(q.offsetY).toBe(0);
	});

	test("centered focal at 2x keeps center fixed", () => {
		const q = cameraQuadForZoom({ scale: 2, focalX: 0.5, focalY: 0.5, canvasWidth: W, canvasHeight: H });
		// center point maps to itself: c*s + offset = c
		expect(W / 2 * q.scale + q.offsetX).toBeCloseTo(W / 2);
		expect(H / 2 * q.scale + q.offsetY).toBeCloseTo(H / 2);
	});

	test("corner focal clamps so frame edge stays at frame edge", () => {
		const q = cameraQuadForZoom({ scale: 2, focalX: 0, focalY: 0, canvasWidth: W, canvasHeight: H });
		// top-left of content stays at top-left (window clamped to 0,0)
		expect(0 * q.scale + q.offsetX).toBeCloseTo(0);
		expect(0 * q.scale + q.offsetY).toBeCloseTo(0);
	});

	test("far-corner focal clamps so bottom-right edge stays put", () => {
		const q = cameraQuadForZoom({ scale: 2, focalX: 1, focalY: 1, canvasWidth: W, canvasHeight: H });
		expect(W * q.scale + q.offsetX).toBeCloseTo(W);
		expect(H * q.scale + q.offsetY).toBeCloseTo(H);
	});
});

describe("applyCameraToQuad", () => {
	test("scales size and remaps center", () => {
		const quad = { centerX: 960, centerY: 540, width: 1920, height: 1080, rotationDegrees: 0, flipX: false, flipY: false };
		const cam = { scale: 2, offsetX: -960, offsetY: -540 };
		const out = applyCameraToQuad({ quad, camera: cam });
		expect(out.width).toBe(3840);
		expect(out.height).toBe(2160);
		expect(out.centerX).toBe(960);
		expect(out.centerY).toBe(540);
		expect(out.rotationDegrees).toBe(0);
	});
});

describe("zoomEnvelopeScale (times in ticks, tps=10)", () => {
	const base = { targetScale: 2, easeInTicks: 10, easeOutTicks: 10, durationTicks: 100, ease: "linear" as const };

	test("in-out: identity at clip edges, target in hold", () => {
		expect(zoomEnvelopeScale({ ...base, mode: "in-out", direction: "in", localTime: 0 })).toBeCloseTo(1);
		expect(zoomEnvelopeScale({ ...base, mode: "in-out", direction: "in", localTime: 50 })).toBeCloseTo(2);
		expect(zoomEnvelopeScale({ ...base, mode: "in-out", direction: "in", localTime: 100 })).toBeCloseTo(1);
		expect(zoomEnvelopeScale({ ...base, mode: "in-out", direction: "in", localTime: 5 })).toBeCloseTo(1.5);
	});

	test("in-out: ramps compress when clip shorter than easeIn+easeOut", () => {
		const s = zoomEnvelopeScale({ ...base, durationTicks: 10, mode: "in-out", direction: "in", localTime: 5 });
		expect(s).toBeCloseTo(2); // 5 ticks in, 5 ticks out
	});

	test("continuous in: 1 -> target across the clip", () => {
		expect(zoomEnvelopeScale({ ...base, mode: "continuous", direction: "in", localTime: 0 })).toBeCloseTo(1);
		expect(zoomEnvelopeScale({ ...base, mode: "continuous", direction: "in", localTime: 100 })).toBeCloseTo(2);
	});

	test("continuous out: target -> 1 across the clip", () => {
		expect(zoomEnvelopeScale({ ...base, mode: "continuous", direction: "out", localTime: 0 })).toBeCloseTo(2);
		expect(zoomEnvelopeScale({ ...base, mode: "continuous", direction: "out", localTime: 100 })).toBeCloseTo(1);
	});
});

describe("inOutEnvelope", () => {
	test("0 at edges, 1 in hold, symmetric ramps", () => {
		const p = { rampTicks: 10, durationTicks: 100 };
		expect(inOutEnvelope({ ...p, localTime: 0 })).toBeCloseTo(0);
		expect(inOutEnvelope({ ...p, localTime: 10 })).toBeCloseTo(1);
		expect(inOutEnvelope({ ...p, localTime: 50 })).toBeCloseTo(1);
		expect(inOutEnvelope({ ...p, localTime: 100 })).toBeCloseTo(0);
	});
});

describe("easeValue", () => {
	test("clamps and hits endpoints", () => {
		for (const ease of ["linear", "smooth", "snappy"] as const) {
			expect(easeValue({ t: 0, ease })).toBeCloseTo(0);
			expect(easeValue({ t: 1, ease })).toBeCloseTo(1);
			expect(easeValue({ t: -1, ease })).toBeCloseTo(0);
			expect(easeValue({ t: 2, ease })).toBeCloseTo(1);
		}
	});
});

describe("highlightLayout", () => {
	const region = { x: 0.5, y: 0.5, w: 0.25, h: 0.25 }; // right-bottom quarter area
	test("progress 0 = cutout in place at natural scale", () => {
		const l = highlightLayout({ region, size: 0.65, progress: 0, canvasWidth: W, canvasHeight: H });
		expect(l.dstRect.x).toBeCloseTo(region.x * W);
		expect(l.dstRect.w).toBeCloseTo(region.w * W);
		expect(l.camera.scale).toBeCloseTo(1);
	});
	test("progress 1 = cutout centered, filling `size` of the frame", () => {
		const l = highlightLayout({ region, size: 0.65, progress: 1, canvasWidth: W, canvasHeight: H });
		// scaled uniformly to fit size% of frame, centered
		const s = Math.min((0.65 * W) / (region.w * W), (0.65 * H) / (region.h * H));
		expect(l.camera.scale).toBeCloseTo(s);
		expect(l.dstRect.x + l.dstRect.w / 2).toBeCloseTo(W / 2);
		expect(l.dstRect.y + l.dstRect.h / 2).toBeCloseTo(H / 2);
	});
	test("camera maps srcRect onto dstRect", () => {
		const l = highlightLayout({ region, size: 0.65, progress: 1, canvasWidth: W, canvasHeight: H });
		const srcCx = (region.x + region.w / 2) * W;
		expect(srcCx * l.camera.scale + l.camera.offsetX).toBeCloseTo(l.dstRect.x + l.dstRect.w / 2);
	});
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `cd ~/dev/creatorgrowth-editor/apps/web && bun test src/lib/effects/__tests__/camera.test.ts`
Expected: FAIL — cannot resolve `../camera`.

- [ ] **Step 3: Implement `camera.ts`**

```ts
// apps/web/src/lib/effects/camera.ts
// Pure camera math for the Magic Zoom layer. No imports from wasm or React.

export interface CameraQuad {
	scale: number;
	offsetX: number;
	offsetY: number;
}

export interface RectPx {
	x: number;
	y: number;
	w: number;
	h: number;
}

export type EaseKind = "linear" | "smooth" | "snappy";
export type ZoomMode = "in-out" | "continuous";
export type ZoomDirection = "in" | "out";

export function easeValue({ t, ease }: { t: number; ease: EaseKind }): number {
	const x = Math.min(1, Math.max(0, t));
	switch (ease) {
		case "linear":
			return x;
		case "snappy":
			// fast start, soft landing (quartic out)
			return 1 - (1 - x) ** 4;
		default:
			// smooth: cubic in-out
			return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
	}
}

/** 0 -> 1 over rampTicks at each clip edge, 1 in the hold. Ramps compress on short clips. */
export function inOutEnvelope({
	localTime,
	rampTicks,
	durationTicks,
	ease = "linear",
}: {
	localTime: number;
	rampTicks: number;
	durationTicks: number;
	ease?: EaseKind;
}): number {
	if (durationTicks <= 0) return 0;
	const ramp = Math.min(rampTicks, durationTicks / 2);
	if (ramp <= 0) return 1;
	const fromStart = localTime / ramp;
	const fromEnd = (durationTicks - localTime) / ramp;
	return easeValue({ t: Math.min(fromStart, fromEnd, 1), ease });
}

export function zoomEnvelopeScale({
	mode,
	direction,
	targetScale,
	easeInTicks,
	easeOutTicks,
	durationTicks,
	localTime,
	ease,
}: {
	mode: ZoomMode;
	direction: ZoomDirection;
	targetScale: number;
	easeInTicks: number;
	easeOutTicks: number;
	durationTicks: number;
	localTime: number;
	ease: EaseKind;
}): number {
	if (durationTicks <= 0) return 1;
	if (mode === "continuous") {
		const p = easeValue({ t: localTime / durationTicks, ease });
		return direction === "out"
			? targetScale + (1 - targetScale) * p
			: 1 + (targetScale - 1) * p;
	}
	// in-out: compress ramps proportionally when the clip is too short
	const total = easeInTicks + easeOutTicks;
	const compress = total > durationTicks ? durationTicks / total : 1;
	const inT = easeInTicks * compress;
	const outT = easeOutTicks * compress;
	let p = 1;
	if (inT > 0 && localTime < inT) {
		p = easeValue({ t: localTime / inT, ease });
	} else if (outT > 0 && localTime > durationTicks - outT) {
		p = easeValue({ t: (durationTicks - localTime) / outT, ease });
	}
	return 1 + (targetScale - 1) * p;
}

/**
 * Camera for a zoom toward a focal point (normalized 0-1).
 * Models a crop window of size canvas/scale centered on the focal point,
 * clamped inside the frame, upscaled to fill the canvas:
 * T(p) = (p - window.xy) * scale
 */
export function cameraQuadForZoom({
	scale,
	focalX,
	focalY,
	canvasWidth,
	canvasHeight,
}: {
	scale: number;
	focalX: number;
	focalY: number;
	canvasWidth: number;
	canvasHeight: number;
}): CameraQuad {
	const s = Math.max(scale, 0.01);
	const winW = canvasWidth / s;
	const winH = canvasHeight / s;
	const winX = clamp(focalX * canvasWidth - winW / 2, 0, canvasWidth - winW);
	const winY = clamp(focalY * canvasHeight - winH / 2, 0, canvasHeight - winH);
	return { scale: s, offsetX: -winX * s, offsetY: -winY * s };
}

/** The visible window rect (px) for a zoom camera — used by the preview overlay. */
export function zoomWindowRect({
	scale,
	focalX,
	focalY,
	canvasWidth,
	canvasHeight,
}: {
	scale: number;
	focalX: number;
	focalY: number;
	canvasWidth: number;
	canvasHeight: number;
}): RectPx {
	const s = Math.max(scale, 0.01);
	const winW = canvasWidth / s;
	const winH = canvasHeight / s;
	return {
		x: clamp(focalX * canvasWidth - winW / 2, 0, canvasWidth - winW),
		y: clamp(focalY * canvasHeight - winH / 2, 0, canvasHeight - winH),
		w: winW,
		h: winH,
	};
}

export interface QuadLike {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	rotationDegrees: number;
	flipX: boolean;
	flipY: boolean;
}

export function applyCameraToQuad({
	quad,
	camera,
}: {
	quad: QuadLike;
	camera: CameraQuad;
}): QuadLike {
	return {
		...quad,
		centerX: quad.centerX * camera.scale + camera.offsetX,
		centerY: quad.centerY * camera.scale + camera.offsetY,
		width: quad.width * camera.scale,
		height: quad.height * camera.scale,
	};
}

export function composeCameras({ inner, outer }: { inner: CameraQuad; outer: CameraQuad }): CameraQuad {
	// outer(inner(p)) = (p*si + oi)*so + oo
	return {
		scale: inner.scale * outer.scale,
		offsetX: inner.offsetX * outer.scale + outer.offsetX,
		offsetY: inner.offsetY * outer.scale + outer.offsetY,
	};
}

/**
 * Layout for the Magic Highlighter at a given pop progress.
 * region: normalized source rect. size: fraction of frame the cutout fills at progress 1.
 * Returns the lerped destination rect and the camera that maps src -> dst.
 */
export function highlightLayout({
	region,
	size,
	progress,
	canvasWidth,
	canvasHeight,
}: {
	region: { x: number; y: number; w: number; h: number };
	size: number;
	progress: number;
	canvasWidth: number;
	canvasHeight: number;
}): { srcRect: RectPx; dstRect: RectPx; camera: CameraQuad } {
	const srcRect: RectPx = {
		x: region.x * canvasWidth,
		y: region.y * canvasHeight,
		w: Math.max(region.w * canvasWidth, 1),
		h: Math.max(region.h * canvasHeight, 1),
	};
	const targetScale = Math.min(
		(size * canvasWidth) / srcRect.w,
		(size * canvasHeight) / srcRect.h,
	);
	const p = Math.min(1, Math.max(0, progress));
	const scale = 1 + (targetScale - 1) * p;
	const srcCx = srcRect.x + srcRect.w / 2;
	const srcCy = srcRect.y + srcRect.h / 2;
	const dstCx = srcCx + (canvasWidth / 2 - srcCx) * p;
	const dstCy = srcCy + (canvasHeight / 2 - srcCy) * p;
	const dstRect: RectPx = {
		x: dstCx - (srcRect.w * scale) / 2,
		y: dstCy - (srcRect.h * scale) / 2,
		w: srcRect.w * scale,
		h: srcRect.h * scale,
	};
	return {
		srcRect,
		dstRect,
		camera: {
			scale,
			offsetX: dstCx - srcCx * scale,
			offsetY: dstCy - srcCy * scale,
		},
	};
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.min(Math.max(v, lo), Math.max(lo, hi));
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `cd ~/dev/creatorgrowth-editor/apps/web && bun test src/lib/effects/__tests__/camera.test.ts`
Expected: PASS (all describe blocks green).

- [ ] **Step 5: Commit**

```bash
cd ~/dev/creatorgrowth-editor
git add apps/web/src/lib/effects/camera.ts apps/web/src/lib/effects/__tests__/camera.test.ts
git commit -m "magic-zoom: pure camera math — zoom window clamp, envelopes, highlight layout (TDD)"
```

---

### Task 2: Effect definition kinds + Magic Zoom / Magic Highlighter definitions

**Files:**
- Modify: `apps/web/src/lib/effects/types.ts` (add `kind`, camera/highlight resolvers)
- Create: `apps/web/src/lib/effects/definitions/magic-zoom.ts`
- Create: `apps/web/src/lib/effects/definitions/magic-highlight.ts`
- Modify: `apps/web/src/lib/effects/definitions/index.ts` + wherever the registry registers definitions (read `apps/web/src/lib/effects/registry.ts` and `index.ts` first, follow the blur pattern)
- Test: `apps/web/src/lib/effects/__tests__/magic-definitions.test.ts`

- [ ] **Step 1: Read `registry.ts`, `index.ts`, `definitions/index.ts`** to see how blur registers and what `buildDefaultEffectInstance` does. Follow that pattern exactly in later steps.

- [ ] **Step 2: Extend `types.ts`** — add after the existing `EffectRendererConfig`:

```ts
export type EffectKind = "passes" | "camera" | "highlight";

export interface ResolvedCameraState {
	scale: number;
	focalX: number; // 0-1
	focalY: number; // 0-1
}

export interface ResolvedHighlightState {
	region: { x: number; y: number; w: number; h: number }; // 0-1
	size: number; // 0-1
	progress: number; // 0-1 pop envelope
	dim: number; // 0-1
	blurIntensity: number; // 0-100, same unit as blur effect
	cornerRadius: number; // px
}
```

and extend `EffectDefinition` with:

```ts
	/** "passes" (default) = shader passes; "camera" = transforms layers below; "highlight" = pop-out cutout */
	kind?: EffectKind;
	resolveCamera?: (params: {
		effectParams: ParamValues;
		localTime: number; // ticks
		duration: number; // ticks
		ticksPerSecond: number;
	}) => ResolvedCameraState | null;
	resolveHighlight?: (params: {
		effectParams: ParamValues;
		localTime: number;
		duration: number;
		ticksPerSecond: number;
	}) => ResolvedHighlightState | null;
```

- [ ] **Step 3: Write failing tests**

```ts
// apps/web/src/lib/effects/__tests__/magic-definitions.test.ts
import { describe, expect, test } from "bun:test";
import { magicZoomEffectDefinition } from "../definitions/magic-zoom";
import { magicHighlightEffectDefinition } from "../definitions/magic-highlight";

const TPS = 10; // tests use a simple tick rate

function defaults(def: { params: Array<{ key: string; default: unknown }> }) {
	return Object.fromEntries(def.params.map((p) => [p.key, p.default]));
}

describe("magic-zoom definition", () => {
	test("kind camera, no passes", () => {
		expect(magicZoomEffectDefinition.kind).toBe("camera");
		expect(magicZoomEffectDefinition.renderer.passes).toHaveLength(0);
	});

	test("in-out: identity at edges, target scale mid-clip", () => {
		const effectParams = { ...defaults(magicZoomEffectDefinition), scale: 2, easeIn: 1, easeOut: 1 };
		const resolve = magicZoomEffectDefinition.resolveCamera!;
		const dur = 100; // 10s at TPS=10
		expect(resolve({ effectParams, localTime: 0, duration: dur, ticksPerSecond: TPS })!.scale).toBeCloseTo(1);
		expect(resolve({ effectParams, localTime: 50, duration: dur, ticksPerSecond: TPS })!.scale).toBeCloseTo(2);
		expect(resolve({ effectParams, localTime: 100, duration: dur, ticksPerSecond: TPS })!.scale).toBeCloseTo(1);
	});

	test("focal percent params map to 0-1", () => {
		const effectParams = { ...defaults(magicZoomEffectDefinition), focalX: 75, focalY: 25 };
		const cam = magicZoomEffectDefinition.resolveCamera!({ effectParams, localTime: 50, duration: 100, ticksPerSecond: TPS })!;
		expect(cam.focalX).toBeCloseTo(0.75);
		expect(cam.focalY).toBeCloseTo(0.25);
	});
});

describe("magic-highlight definition", () => {
	test("kind highlight, progress envelope hits 0/1/0", () => {
		const effectParams = { ...defaults(magicHighlightEffectDefinition), transition: 1 };
		const resolve = magicHighlightEffectDefinition.resolveHighlight!;
		const dur = 100;
		expect(resolve({ effectParams, localTime: 0, duration: dur, ticksPerSecond: TPS })!.progress).toBeCloseTo(0);
		expect(resolve({ effectParams, localTime: 50, duration: dur, ticksPerSecond: TPS })!.progress).toBeCloseTo(1);
		expect(resolve({ effectParams, localTime: 100, duration: dur, ticksPerSecond: TPS })!.progress).toBeCloseTo(0);
	});

	test("region percent params normalize", () => {
		const effectParams = { ...defaults(magicHighlightEffectDefinition), regionX: 10, regionY: 20, regionW: 30, regionH: 40 };
		const hl = magicHighlightEffectDefinition.resolveHighlight!({ effectParams, localTime: 50, duration: 100, ticksPerSecond: TPS })!;
		expect(hl.region).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
	});
});
```

- [ ] **Step 4: Run tests, verify fail** (`bun test src/lib/effects/__tests__/magic-definitions.test.ts` — module not found)

- [ ] **Step 5: Implement `definitions/magic-zoom.ts`**

```ts
import type { EffectDefinition } from "@/lib/effects/types";
import {
	type EaseKind,
	type ZoomDirection,
	type ZoomMode,
	zoomEnvelopeScale,
} from "@/lib/effects/camera";

function num(v: unknown, fallback: number): number {
	const n = typeof v === "number" ? v : Number.parseFloat(String(v));
	return Number.isFinite(n) ? n : fallback;
}

export const magicZoomEffectDefinition: EffectDefinition = {
	type: "magic-zoom",
	name: "Magic Zoom",
	keywords: ["zoom", "magic", "punch", "push", "camera"],
	kind: "camera",
	params: [
		{
			key: "mode",
			label: "Mode",
			type: "select",
			default: "in-out",
			options: [
				{ value: "in-out", label: "In & out" },
				{ value: "continuous", label: "Continuous" },
			],
		},
		{ key: "scale", label: "Zoom", type: "number", default: 1.8, min: 1, max: 4, step: 0.05 },
		{ key: "focalX", label: "Focus X", type: "number", default: 50, min: 0, max: 100, step: 1 },
		{ key: "focalY", label: "Focus Y", type: "number", default: 50, min: 0, max: 100, step: 1 },
		{ key: "easeIn", label: "Ease in (s)", type: "number", default: 0.5, min: 0, max: 3, step: 0.1 },
		{ key: "easeOut", label: "Ease out (s)", type: "number", default: 0.5, min: 0, max: 3, step: 0.1 },
		{
			key: "ease",
			label: "Easing",
			type: "select",
			default: "smooth",
			options: [
				{ value: "smooth", label: "Smooth" },
				{ value: "snappy", label: "Snappy" },
				{ value: "linear", label: "Linear" },
			],
		},
		{
			key: "direction",
			label: "Direction (continuous)",
			type: "select",
			default: "in",
			options: [
				{ value: "in", label: "Zoom in" },
				{ value: "out", label: "Zoom out" },
			],
		},
	],
	renderer: { passes: [] },
	resolveCamera: ({ effectParams, localTime, duration, ticksPerSecond }) => {
		const scale = zoomEnvelopeScale({
			mode: (effectParams.mode as ZoomMode) ?? "in-out",
			direction: (effectParams.direction as ZoomDirection) ?? "in",
			targetScale: num(effectParams.scale, 1.8),
			easeInTicks: num(effectParams.easeIn, 0.5) * ticksPerSecond,
			easeOutTicks: num(effectParams.easeOut, 0.5) * ticksPerSecond,
			durationTicks: duration,
			localTime,
			ease: (effectParams.ease as EaseKind) ?? "smooth",
		});
		if (Math.abs(scale - 1) < 1e-4) return null;
		return {
			scale,
			focalX: num(effectParams.focalX, 50) / 100,
			focalY: num(effectParams.focalY, 50) / 100,
		};
	},
};
```

- [ ] **Step 6: Implement `definitions/magic-highlight.ts`**

```ts
import type { EffectDefinition } from "@/lib/effects/types";
import { inOutEnvelope } from "@/lib/effects/camera";

function num(v: unknown, fallback: number): number {
	const n = typeof v === "number" ? v : Number.parseFloat(String(v));
	return Number.isFinite(n) ? n : fallback;
}

export const magicHighlightEffectDefinition: EffectDefinition = {
	type: "magic-highlight",
	name: "Magic Highlighter",
	keywords: ["highlight", "magic", "spotlight", "cutout", "focus"],
	kind: "highlight",
	params: [
		{ key: "regionX", label: "Region X", type: "number", default: 25, min: 0, max: 100, step: 1 },
		{ key: "regionY", label: "Region Y", type: "number", default: 25, min: 0, max: 100, step: 1 },
		{ key: "regionW", label: "Region width", type: "number", default: 50, min: 2, max: 100, step: 1 },
		{ key: "regionH", label: "Region height", type: "number", default: 50, min: 2, max: 100, step: 1 },
		{ key: "size", label: "Pop size", type: "number", default: 65, min: 20, max: 100, step: 1 },
		{ key: "transition", label: "Transition (s)", type: "number", default: 0.5, min: 0, max: 2, step: 0.05 },
		{ key: "dim", label: "Background dim", type: "number", default: 70, min: 0, max: 100, step: 1 },
		{ key: "blur", label: "Background blur", type: "number", default: 25, min: 0, max: 100, step: 1 },
		{ key: "cornerRadius", label: "Corner radius", type: "number", default: 12, min: 0, max: 48, step: 1 },
	],
	renderer: { passes: [] },
	resolveHighlight: ({ effectParams, localTime, duration, ticksPerSecond }) => {
		const progress = inOutEnvelope({
			localTime,
			rampTicks: num(effectParams.transition, 0.5) * ticksPerSecond,
			durationTicks: duration,
			ease: "smooth",
		});
		return {
			region: {
				x: num(effectParams.regionX, 25) / 100,
				y: num(effectParams.regionY, 25) / 100,
				w: num(effectParams.regionW, 50) / 100,
				h: num(effectParams.regionH, 50) / 100,
			},
			size: num(effectParams.size, 65) / 100,
			progress,
			dim: num(effectParams.dim, 70) / 100,
			blurIntensity: num(effectParams.blur, 25),
			cornerRadius: num(effectParams.cornerRadius, 12),
		};
	},
};
```

- [ ] **Step 7: Register both definitions** following the blur pattern found in Step 1 (likely an array or `register` calls in `definitions/index.ts` / `registry.ts`). Order them so Magic Zoom and Magic Highlighter appear first in the panel.

- [ ] **Step 8: Run tests, verify pass.** Also run `bunx tsc --noEmit -p apps/web` (or the repo's typecheck script — check `package.json` scripts; biome handles lint) and confirm no new type errors. NOTE: existing `resolveEffectPasses` consumers must tolerate `renderer.passes: []` — it already returns `[]` for empty pass lists (blur returns `[]` below threshold), so no change needed.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/effects/types.ts apps/web/src/lib/effects/definitions/magic-zoom.ts apps/web/src/lib/effects/definitions/magic-highlight.ts apps/web/src/lib/effects/definitions/index.ts apps/web/src/lib/effects/__tests__/magic-definitions.test.ts
# plus registry.ts if modified
git commit -m "magic-zoom: Magic Zoom + Magic Highlighter effect definitions (kind=camera/highlight)"
```

---

### Task 3: Resolve path — effect-layer node carries camera/highlight state

**Files:**
- Modify: `apps/web/src/services/renderer/nodes/effect-layer-node.ts`
- Modify: `apps/web/src/services/renderer/resolve.ts:439-468` (`resolveEffectLayerNode`)

- [ ] **Step 1: Extend `ResolvedEffectLayerNodeState`**

```ts
import type { EffectPass } from "@/lib/effects/types";
import type { ResolvedCameraState, ResolvedHighlightState } from "@/lib/effects/types";
import type { ParamValues } from "@/lib/params";
import { BaseNode } from "./base-node";

export type EffectLayerNodeParams = {
	effectType: string;
	effectParams: ParamValues;
	timeOffset: number;
	duration: number;
};

export type ResolvedEffectLayerNodeState = {
	passes: EffectPass[];
	camera?: ResolvedCameraState | null;
	highlight?: ResolvedHighlightState | null;
};

export class EffectLayerNode extends BaseNode<
	EffectLayerNodeParams,
	ResolvedEffectLayerNodeState
> {}
```

- [ ] **Step 2: Branch `resolveEffectLayerNode` in `resolve.ts`** — replace the existing function body after the time-window check with:

```ts
	const definition = effectsRegistry.get(node.params.effectType);
	const localTime = time - node.params.timeOffset;

	if (definition?.kind === "camera" && definition.resolveCamera) {
		const camera = definition.resolveCamera({
			effectParams: node.params.effectParams,
			localTime,
			duration: node.params.duration,
			ticksPerSecond: TICKS_PER_SECOND,
		});
		if (!camera) return null;
		return { passes: [], camera };
	}

	if (definition?.kind === "highlight" && definition.resolveHighlight) {
		const highlight = definition.resolveHighlight({
			effectParams: node.params.effectParams,
			localTime,
			duration: node.params.duration,
			ticksPerSecond: TICKS_PER_SECOND,
		});
		if (!highlight) return null;
		return { passes: [], highlight };
	}

	const passes = resolveEffectPasses({
		definition,
		effectParams: node.params.effectParams,
		width: context.renderer.width,
		height: context.renderer.height,
	});
	if (passes.length === 0) {
		return null;
	}

	return {
		passes,
	};
```

Add `import { TICKS_PER_SECOND } from "@/lib/wasm";` at the top of `resolve.ts` (check `@/lib/wasm` exports it — preview/index.tsx imports it from there).

- [ ] **Step 3: Typecheck** (`bunx tsc --noEmit` or repo script). Expected: clean (frame-descriptor still only reads `.passes`, which exists).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/services/renderer/nodes/effect-layer-node.ts apps/web/src/services/renderer/resolve.ts
git commit -m "magic-zoom: resolve camera/highlight state on effect layer nodes"
```

---

### Task 4: Frame descriptor — apply the camera to layers below

**Files:**
- Modify: `apps/web/src/services/renderer/compositor/frame-descriptor.ts`

The RootNode branch of `collectNode` (line 78-89) iterates children bottom-to-top. Replace it with a pre-pass + camera-aware iteration. All other `collectNode` branches gain an optional `camera` argument that they apply to the quads they push.

- [ ] **Step 1: Restructure the RootNode branch**

```ts
	if (node instanceof RootNode) {
		// Topmost active camera wins (spec: last-on-top). It applies to every child BELOW it.
		let cameraNodeIndex = -1;
		let camera: CameraQuad | null = null;
		for (let index = node.children.length - 1; index >= 0; index--) {
			const child = node.children[index];
			if (
				child instanceof EffectLayerNode &&
				child.resolved?.camera
			) {
				camera = cameraQuadForZoom({
					scale: child.resolved.camera.scale,
					focalX: child.resolved.camera.focalX,
					focalY: child.resolved.camera.focalY,
					canvasWidth: renderer.width,
					canvasHeight: renderer.height,
				});
				cameraNodeIndex = index;
				break;
			}
		}

		for (let index = 0; index < node.children.length; index++) {
			await collectNode({
				node: node.children[index],
				renderer,
				path: `${path}:${index}`,
				items,
				textures,
				camera: index < cameraNodeIndex ? camera : null,
				belowNodes: node.children.slice(0, index),
			});
		}
		return;
	}
```

- [ ] **Step 2: Thread `camera` + `belowNodes` through `collectNode`'s signature**

```ts
async function collectNode({
	node,
	renderer,
	path,
	items,
	textures,
	camera = null,
	belowNodes = [],
}: {
	node: AnyBaseNode;
	renderer: CanvasRenderer;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
	camera?: CameraQuad | null;
	belowNodes?: AnyBaseNode[];
}): Promise<void> {
```

Imports to add at the top:

```ts
import {
	applyCameraToQuad,
	cameraQuadForZoom,
	highlightLayout,
	type CameraQuad,
} from "@/lib/effects/camera";
import { buildGaussianBlurPasses, intensityToSigma } from "@/lib/effects/definitions/blur";
```

- [ ] **Step 3: Apply the camera at every place a quad is computed**

In `collectVisualSourceNode` (gains the same optional `camera` param, passed from `collectNode`): after `const transform = computeVisualTransform({...})` add:

```ts
	const finalTransform = camera
		? applyCameraToQuad({ quad: transform, camera })
		: transform;
```

and use `finalTransform` everywhere `transform` was used below that line (the `buildMaskArtifacts` call and the pushed layer item).

In `collectTextNode` (same optional `camera` param): replace `transform: fullCanvasTransform(renderer)` in the pushed item with:

```ts
	transform: camera
		? applyCameraToQuad({ quad: fullCanvasTransform(renderer), camera })
		: fullCanvasTransform(renderer),
```

ColorNode and BlurBackgroundNode keep their untransformed full-canvas quads (backgrounds stay backgrounds — zooming a solid color is a no-op and zooming the blur backdrop would expose edges at the clamp boundary).

- [ ] **Step 4: Manual verification in preview**

Run the dev server (`cd apps/web && bun dev` — check `package.json` for the exact script), open the editor, add any video, drag a Magic Zoom from the Effects panel onto the timeline above it (the panel section ships in Task 6 — for now use the existing Effects view which lists all registry definitions; Magic Zoom appears there after Task 2). Scrub across the clip: the video should ease in to 1.8× toward center and ease back out at the clip's end.
Expected: zoom visible while scrubbing inside the clip; no zoom outside it.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/services/renderer/compositor/frame-descriptor.ts
git commit -m "magic-zoom: camera transform applied to layers below the zoom clip (preview+export path)"
```

---

### Task 5: Frame descriptor — Magic Highlighter emission

**Files:**
- Modify: `apps/web/src/services/renderer/compositor/frame-descriptor.ts` (EffectLayerNode branch)

- [ ] **Step 1: Replace the EffectLayerNode branch of `collectNode`**

```ts
	if (node instanceof EffectLayerNode) {
		if (!node.resolved) {
			return;
		}

		if (node.resolved.highlight) {
			await collectHighlight({
				highlight: node.resolved.highlight,
				renderer,
				path,
				items,
				textures,
				belowNodes,
			});
			return;
		}

		if (node.resolved.camera) {
			// camera is applied by the RootNode pre-pass; the node itself emits nothing
			return;
		}

		if (node.resolved.passes.length === 0) {
			return;
		}
		items.push({
			type: "sceneEffect",
			effectPassGroups: [node.resolved.passes],
		});
		return;
	}
```

- [ ] **Step 2: Implement `collectHighlight`** (new function in the same file)

```ts
async function collectHighlight({
	highlight,
	renderer,
	path,
	items,
	textures,
	belowNodes,
}: {
	highlight: NonNullable<ResolvedEffectLayerNodeState["highlight"]>;
	renderer: CanvasRenderer;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
	belowNodes: AnyBaseNode[];
}) {
	const { progress } = highlight;
	if (progress <= 0.001) return;

	// 1. Blur the composite below (existing gaussian shader), scaled by progress
	if (highlight.blurIntensity > 0) {
		const passes = buildGaussianBlurPasses({
			sigmaX: intensityToSigma({
				intensity: highlight.blurIntensity * progress,
				resolution: renderer.width,
				reference: 1920,
			}),
			sigmaY: intensityToSigma({
				intensity: highlight.blurIntensity * progress,
				resolution: renderer.height,
				reference: 1080,
			}),
		});
		if (passes.length > 0) {
			items.push({ type: "sceneEffect", effectPassGroups: [passes] });
		}
	}

	// 2. Dim quad
	if (highlight.dim > 0) {
		const dimTextureId = `${path}:hl-dim`;
		const dimCanvas = createOffscreenCanvas({ width: 2, height: 2 });
		const dimCtx = dimCanvas.getContext("2d") as
			| CanvasRenderingContext2D
			| OffscreenCanvasRenderingContext2D
			| null;
		if (dimCtx) {
			dimCtx.fillStyle = "black";
			dimCtx.fillRect(0, 0, 2, 2);
			textures.set(dimTextureId, {
				id: dimTextureId,
				source: dimCanvas,
				width: 2,
				height: 2,
			});
			items.push({
				type: "layer",
				textureId: dimTextureId,
				transform: fullCanvasTransform(renderer),
				opacity: highlight.dim * progress,
				blendMode: "normal",
				effectPassGroups: [],
				mask: null,
			});
		}
	}

	// 3. The cutout: re-emit the visual layers below with the pop camera + a rounded-rect mask
	const layout = highlightLayout({
		region: highlight.region,
		size: highlight.size,
		progress,
		canvasWidth: renderer.width,
		canvasHeight: renderer.height,
	});

	const maskTextureId = `${path}:hl-mask`;
	const maskCanvas = createOffscreenCanvas({
		width: renderer.width,
		height: renderer.height,
	});
	const maskCtx = maskCanvas.getContext("2d") as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D
		| null;
	if (!maskCtx) return;
	maskCtx.fillStyle = "white";
	const r = Math.min(
		highlight.cornerRadius,
		layout.dstRect.w / 2,
		layout.dstRect.h / 2,
	);
	maskCtx.beginPath();
	maskCtx.roundRect(layout.dstRect.x, layout.dstRect.y, layout.dstRect.w, layout.dstRect.h, r);
	maskCtx.fill();
	textures.set(maskTextureId, {
		id: maskTextureId,
		source: maskCanvas,
		width: renderer.width,
		height: renderer.height,
	});
	const cutoutMask: LayerMaskDescriptor = {
		textureId: maskTextureId,
		feather: 0,
		inverted: false,
	};

	const cutoutItems: FrameItemDescriptor[] = [];
	for (let i = 0; i < belowNodes.length; i++) {
		const child = belowNodes[i];
		if (child instanceof EffectLayerNode || child instanceof ColorNode || child instanceof BlurBackgroundNode) {
			continue;
		}
		await collectNode({
			node: child,
			renderer,
			path: `${path}:hl:${i}`,
			items: cutoutItems,
			textures,
			camera: layout.camera,
		});
	}
	for (const item of cutoutItems) {
		if (item.type === "layer") {
			items.push({ ...item, mask: cutoutMask });
		}
	}
}
```

Add the import of `ResolvedEffectLayerNodeState` type:
`import { EffectLayerNode, type ResolvedEffectLayerNodeState } from "../nodes/effect-layer-node";` (replacing the existing EffectLayerNode import).

NOTE on texture ids: the re-collect uses a `:hl:` path prefix → text re-renders into a fresh texture; video/image/sticker textures dedupe naturally is NOT true here (their ids derive from path) — they will upload twice. Acceptable for MVP (one extra texture per visible layer during a highlight); if it shows in profiling, switch re-emission to reuse the original item's textureId later.

NOTE on `roundRect`: available in all modern browsers (Chrome 99+); the editor already requires WebGPU-class browsers, fine.

- [ ] **Step 3: Manual verification in preview**

Dev server: add a video, drag Magic Highlighter above it. Scrub: background blurs+dims while the selected region (default: center 50%) pops to the middle at 65% size with rounded corners; reverses near clip end.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/services/renderer/compositor/frame-descriptor.ts
git commit -m "magic-zoom: Magic Highlighter — blur+dim composite below, pop-out masked cutout re-emission"
```

---

### Task 6: Effects panel section + keep magic effects off per-clip lists

**Files:**
- Modify: `apps/web/src/components/editor/panels/assets/views/effects.tsx`
- Possibly modify: wherever `ClipEffectsTab` builds its add-effect list (grep `effectsRegistry.list\|effectsRegistry.getAll\|effectsRegistry` in `apps/web/src` outside raw-cut/final-pass and filter `kind !== "passes"` out of clip-level pickers; also check `add-effect.ts` callers)

- [ ] **Step 1: Read `effects.tsx` fully.** Split the rendered list into two sections: "Magic Zoom" (definitions with `kind === "camera" || kind === "highlight"`) listed FIRST under that header, then "Effects" (the rest). Reuse the existing `EffectItem` card component for both. For magic items pass `dragData.targetElementTypes: []` so they cannot be dropped onto a clip (they only make sense as scene clips); `onAddToTimeline` / timeline drop still works via `placement: { mode: "auto", trackType: "effect" }`.

- [ ] **Step 2: Filter magic kinds out of any per-clip effect picker** (the `ClipEffectsTab` add list and the `AddClipEffectCommand` pathway must never receive `magic-*` types): at every place the registry is enumerated for clip effects, filter `(definition.kind ?? "passes") === "passes"`.

- [ ] **Step 3: Friendly clip names.** In `buildEffectElement` (`apps/web/src/lib/timeline/element-utils.ts:139`), use the definition display name when available:

```ts
import { effectsRegistry } from "@/lib/effects";
// in buildEffectElement:
	const definition = effectsRegistry.get(effectType);
	return {
		type: "effect",
		name: definition?.name ?? capitalizeFirstLetter({ string: instance.type }),
		...
```

(Watch for import cycles: `element-utils` ← timeline; effects registry imports nothing from timeline, so this is safe.)

- [ ] **Step 4: Manual verification** — panel shows "Magic Zoom" section with the two cards first; drag each onto the timeline; clips read "Magic Zoom" / "Magic Highlighter"; selecting one shows auto-generated sliders/selects in Properties; adjusting `scale` live-updates the preview (the `useElementPreview` path in `StandaloneEffectTab` already handles preview/commit).

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/editor/panels/assets/views/effects.tsx apps/web/src/lib/timeline/element-utils.ts
# plus the clip-picker file(s) modified in step 2
git commit -m "magic-zoom: Magic Zoom panel section, scene-only placement, friendly clip names"
```

---

### Task 7: Preview region overlay

**Files:**
- Create: `apps/web/src/components/editor/panels/preview/magic-region-overlay.tsx`
- Modify: `apps/web/src/components/editor/panels/preview/index.tsx` (mount next to `{overlays.bookmarks && <BookmarkNoteOverlay />}` at ~line 281)

- [ ] **Step 1: Read `BookmarkNoteOverlay`** (same folder) to copy its canvas-space → screen-space positioning approach exactly (it must already account for the preview viewport pan/zoom). Also read `apps/web/src/components/editor/panels/properties/hooks` / `use-element-preview` for the `previewUpdates`/`commit` contract and `useElementSelection` for selection.

- [ ] **Step 2: Implement the overlay.** Behavior contract:

- Renders only when exactly one element is selected AND it's an `EffectElement` whose definition kind is `camera` or `highlight`.
- **Magic Zoom selected:** draw the *zoom window* rect from `zoomWindowRect({ scale, focalX, focalY, ... })` (import from `@/lib/effects/camera`) as a gold-bordered rectangle with a dimmed outside. Dragging the rect body writes `focalX/focalY` (percent, clamped 0–100). Dragging corner handles resizes → writes `scale = clamp(100 / widthPercent, 1, 4)` keeping the aspect locked to the canvas aspect. Use `previewUpdates({ params })` during drag, `commit()` on pointer-up (same pattern as `StandaloneEffectTab.previewParam`).
- **Magic Highlighter selected:** the rect maps directly to `regionX/Y/W/H` (percent). Body drag moves, corner handles resize freely.
- Label the rect "Magic Zoom" / "Highlight region" in a small badge.
- Pointer math: the overlay is an absolutely-positioned div covering the canvas element; convert pointer deltas with `rect = overlayEl.getBoundingClientRect()`, `dxPercent = (e.clientX - startX) / rect.width * 100`.

Skeleton (adapt mount/positioning to what Step 1 found):

```tsx
"use client";

import { useCallback, useRef } from "react";
import { effectsRegistry } from "@/lib/effects";
import { zoomWindowRect } from "@/lib/effects/camera";
import type { EffectElement } from "@/lib/timeline";
import { useElementSelection } from "<exact path found in step 1 — properties/index.tsx imports it>";
import { useElementPreview } from "@/hooks/use-element-preview";

function clampPct(v: number, lo = 0, hi = 100) {
	return Math.min(hi, Math.max(lo, v));
}

export function MagicRegionOverlay() {
	const { selectedElements } = useElementSelection();
	if (selectedElements.length !== 1) return null;
	const sel = selectedElements[0];
	if (sel.element.type !== "effect") return null;
	const definition = effectsRegistry.get(sel.element.effectType);
	const kind = definition?.kind ?? "passes";
	if (kind !== "camera" && kind !== "highlight") return null;
	return <RegionEditor element={sel.element} trackId={sel.trackId} kind={kind} />;
}

function RegionEditor({ element, trackId, kind }: { element: EffectElement; trackId: string; kind: "camera" | "highlight" }) {
	const { renderElement, previewUpdates, commit } = useElementPreview({
		trackId,
		elementId: element.id,
		fallback: element,
	});
	const params = (renderElement as EffectElement).params;
	const overlayRef = useRef<HTMLDivElement>(null);
	const num = (k: string, d: number) => (typeof params[k] === "number" ? (params[k] as number) : d);

	// rect in percent of canvas
	const rect =
		kind === "camera"
			? (() => {
					const w = zoomWindowRect({
						scale: num("scale", 1.8),
						focalX: num("focalX", 50) / 100,
						focalY: num("focalY", 50) / 100,
						canvasWidth: 100,
						canvasHeight: 100,
					});
					return { x: w.x, y: w.y, w: w.w, h: w.h };
				})()
			: { x: num("regionX", 25), y: num("regionY", 25), w: num("regionW", 50), h: num("regionH", 50) };

	const writeRect = useCallback(
		(r: { x: number; y: number; w: number; h: number }, final: boolean) => {
			const next =
				kind === "camera"
					? {
							...params,
							focalX: clampPct(r.x + r.w / 2),
							focalY: clampPct(r.y + r.h / 2),
							scale: Math.min(4, Math.max(1, 100 / Math.max(r.w, 25))),
						}
					: {
							...params,
							regionX: clampPct(r.x),
							regionY: clampPct(r.y),
							regionW: clampPct(r.w, 2),
							regionH: clampPct(r.h, 2),
						};
			previewUpdates({ params: next });
			if (final) commit();
		},
		[kind, params, previewUpdates, commit],
	);

	// pointer-drag handlers for body + 4 corner handles operate on `rect`,
	// call writeRect(draggedRect, false) on move and writeRect(..., true) on pointerup.
	// Visual: absolute inset-0 container; child div at rect% with gold border,
	// rgba(0,0,0,0.35) outside via box-shadow: 0 0 0 9999px.
	...
}
```

(The `...` body is plain pointer-event bookkeeping — implement fully: `onPointerDown` records start rect + pointer, `setPointerCapture`, `onPointerMove` computes the new rect, corner handles adjust x/y/w/h, body drag adjusts x/y only. Zoom rect keeps canvas aspect: on corner drag derive `w` then set `h = w * canvasH/canvasW`... since rect is in % of each axis, aspect-locked zoom window means `h === w` in percent space — enforce `h = w`.)

- [ ] **Step 3: Mount it** in `preview/index.tsx` beside the bookmark overlay: `<MagicRegionOverlay />` (no `overlays.*` gate — selection-gated instead). Confirm it sits inside the same canvas-positioned wrapper BookmarkNoteOverlay uses, so pan/zoom of the preview viewport moves it with the canvas.

- [ ] **Step 4: Manual verification** — select a Magic Zoom clip → gold window rect appears; dragging it pans the zoom live; corner-resize changes zoom level; pointer-up persists (undo works). Same for Highlighter region. Deselect → overlay gone.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/components/editor/panels/preview/magic-region-overlay.tsx apps/web/src/components/editor/panels/preview/index.tsx
git commit -m "magic-zoom: interactive region overlay on the previewer (zoom window + highlight region)"
```

---

### Task 8: Full test pass + deploy + hand to Andy

- [ ] **Step 1: Run the whole web test suite**: `cd apps/web && bun test 2>&1 | tail -20`. Expected: everything green except the documented pre-existing wasm-load failures. Run lint/format: `bunx biome check --write` on touched files only.

- [ ] **Step 2: Production build check**: `bun run build` (or the repo's build script) — must succeed; Docker build on the VPS uses the same.

- [ ] **Step 3: Deploy** (never ask):

```bash
cd ~/dev/creatorgrowth-editor
git branch -f creatorgrowth-deploy motion-graphics-judged
git push origin motion-graphics-judged creatorgrowth-deploy
ssh user@YOUR_VPS_IP "cd /opt/creatorgrowth-editor && git fetch origin && git reset --hard origin/creatorgrowth-deploy && docker compose build web && docker compose up -d --force-recreate web"
```

CAUTION: shared worktree — confirm `git status` shows no foreign staged files before each commit, and coordinate the deploy (the push ships whatever is committed on the branch, including the Raw Cut agent's commits — that is expected and fine; deploy-branch resets on the VPS are the established flow).

- [ ] **Step 4: Surface the result**: tell Andy it's live at https://creatorgrowth.com/editor — drag Magic Zoom / Magic Highlighter from the Effects panel onto the timeline.
