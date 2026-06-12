import type { MagicPlanClip } from "./types";

// The visible crop a reframe/zoom clip produces, in source pixels. Mirrors
// how the magic-reframe/magic-zoom effects frame the video: crop size is
// frame/scale, centered on the focal point (percent space), clamped so the
// crop never leaves the frame. Pure — used by the offline eval harness to
// cut the exact region a viewer would see and check it visually.

export interface CropRect {
	x: number;
	y: number;
	w: number;
	h: number;
}

export function cropRectForClip({
	clip,
	frameW,
	frameH,
}: {
	clip: Pick<MagicPlanClip, "scale" | "focalX" | "focalY">;
	frameW: number;
	frameH: number;
}): CropRect {
	const scale = Math.max(1, clip.scale);
	const w = frameW / scale;
	const h = frameH / scale;
	const x = Math.min(Math.max((clip.focalX / 100) * frameW - w / 2, 0), frameW - w);
	const y = Math.min(Math.max((clip.focalY / 100) * frameH - h / 2, 0), frameH - h);
	return { x, y, w, h };
}
