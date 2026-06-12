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

/**
 * Zoom progress 0..1 at clip-local time. 0 = no zoom, 1 = fully on target.
 * in-out: ramps up over easeIn, holds at 1, ramps down over easeOut.
 * continuous: one steady ramp across the clip (direction out = 1 -> 0).
 */
export function zoomEnvelopeProgress({
	mode,
	direction,
	easeInTicks,
	easeOutTicks,
	durationTicks,
	localTime,
	ease,
}: {
	mode: ZoomMode;
	direction: ZoomDirection;
	easeInTicks: number;
	easeOutTicks: number;
	durationTicks: number;
	localTime: number;
	ease: EaseKind;
}): number {
	if (durationTicks <= 0) return 0;
	if (mode === "continuous") {
		const p = easeValue({ t: localTime / durationTicks, ease });
		return direction === "out" ? 1 - p : p;
	}
	// in-out: compress ramps proportionally when the clip is too short
	const total = easeInTicks + easeOutTicks;
	const compress = total > durationTicks ? durationTicks / total : 1;
	const inT = easeInTicks * compress;
	const outT = easeOutTicks * compress;
	if (inT > 0 && localTime < inT) {
		return easeValue({ t: localTime / inT, ease });
	}
	if (outT > 0 && localTime > durationTicks - outT) {
		return easeValue({ t: (durationTicks - localTime) / outT, ease });
	}
	return 1;
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
	// + 0 normalizes -0 so identity cameras compare clean
	return { scale: s, offsetX: -winX * s + 0, offsetY: -winY * s + 0 };
}

/**
 * Camera at intermediate zoom progress, kink-free: the crop window LERPs from
 * the full frame to its final clamped target, so both edges travel uniformly.
 * Computing the window per frame from the instantaneous scale instead (as
 * cameraQuadForZoom does) makes off-center zooms anchor on one edge while the
 * clamp is saturated, then pan — a visible two-phase move.
 */
export function cameraQuadForZoomProgress({
	targetScale,
	focalX,
	focalY,
	progress,
	canvasWidth,
	canvasHeight,
}: {
	targetScale: number;
	focalX: number;
	focalY: number;
	progress: number;
	canvasWidth: number;
	canvasHeight: number;
}): CameraQuad {
	const s = Math.max(targetScale, 0.01);
	const e = Math.min(1, Math.max(0, progress));
	const targetW = canvasWidth / s;
	const targetH = canvasHeight / s;
	const targetX = clamp(
		focalX * canvasWidth - targetW / 2,
		0,
		canvasWidth - targetW,
	);
	const targetY = clamp(
		focalY * canvasHeight - targetH / 2,
		0,
		canvasHeight - targetH,
	);
	const winW = canvasWidth + (targetW - canvasWidth) * e;
	const winX = targetX * e;
	const winY = targetY * e;
	const scale = canvasWidth / winW;
	return { scale, offsetX: -winX * scale + 0, offsetY: -winY * scale + 0 };
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

export function composeCameras({
	inner,
	outer,
}: {
	inner: CameraQuad;
	outer: CameraQuad;
}): CameraQuad {
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
