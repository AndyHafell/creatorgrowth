"use client";

import { useEffect, useReducer, useRef, useState } from "react";
import type { SilenceRange } from "@/lib/media/audio";
import { computeGlobalMaxRms, extractRmsRange } from "@/lib/media/audio";
import { cn } from "@/utils/ui";

interface RawCutWaveformProps {
	buffer: AudioBuffer;
	silenceRanges: SilenceRange[];
	blueRanges?: SilenceRange[];
	/** Lock/mark flag ticks at segment starts (buffer timebase). */
	markers?: Array<{ sec: number; kind: "lock" | "mark" }>;
	/** Chapter markers — downward blue triangles in the ruler (MEDIA timebase, so
	 *  they sit exactly where the playhead would; they track zoom/pan). */
	chapterMarkers?: Array<{ sec: number; title: string }>;
	/** Feedback markers — downward PURPLE triangles in the ruler (MEDIA timebase).
	 *  Andy's hand-flagged notes; distinct from the blue chapter pins. */
	feedbackMarkers?: Array<{ sec: number; title: string }>;
	/** Commit a dragged chapter pin to a new time (media seconds). Drag is enabled
	 *  only when this is provided (Raw Cut omits it → pins are static there). */
	onChapterRetime?: (index: number, sec: number) => void;
	/** Commit a dragged feedback pin to a new time (media seconds). */
	onFeedbackRetime?: (index: number, sec: number) => void;
	/** Index of the feedback pin whose inline note editor is open (or null). When
	 *  set, an input is overlaid at that pin so the note is edited on the timeline
	 *  itself — no side panel. Controlled by the parent. */
	editingFeedbackIndex?: number | null;
	/** Double-clicked a feedback pin → open its inline editor (parent sets index). */
	onFeedbackEditOpen?: (index: number) => void;
	/** Inline editor text changed → commit the note. */
	onFeedbackNoteChange?: (index: number, note: string) => void;
	/** Inline editor dismissed (Enter / Escape / blur). */
	onFeedbackEditClose?: () => void;
	/** Delete a feedback pin (the ✕ in its inline editor). */
	onFeedbackDelete?: (index: number) => void;
	/** Same inline-on-the-timeline editing for blue CHAPTER pins (double-click / M).
	 *  Index of the chapter pin whose inline title editor is open (or null). */
	editingChapterIndex?: number | null;
	onChapterEditOpen?: (index: number) => void;
	onChapterNoteChange?: (index: number, title: string) => void;
	onChapterEditClose?: () => void;
	onChapterDelete?: (index: number) => void;
	/** The segment under the playhead — drawn with a subtle outline. */
	activeRange?: { startSec: number; endSec: number };
	currentTime?: number;
	/**
	 * Playable (media-element) duration in seconds — the timebase the playhead
	 * and click-to-seek live in. Distinct from `buffer.duration`: the analysis
	 * buffer is resampled to 8kHz with per-chunk floor() rounding, so its
	 * duration drifts shorter than the real clip (worse the longer the clip).
	 * Bars/bands use `buffer.duration`; playhead/seek use this. Defaults to
	 * `buffer.duration` when not provided.
	 */
	durationSec?: number;
	/** 1 = fit entire clip; >1 = zoomed in, scrolled to keep the playhead centered. */
	zoom?: number;
	onSeek?: (sec: number) => void;
	/** Vertical wheel zoom: multiply the current zoom by `factor`. */
	onZoomBy?: (factor: number) => void;
	className?: string;
}

// Safely under all browser canvas limits (Safari iOS ~4k, desktop ~16k/32k).
const MAX_CANVAS_CSS_WIDTH = 6000;
// Overscan past the viewport edges so quick playhead moves don't reveal blank
// canvas before the next redraw fires.
const VIEWPORT_OVERSCAN = 400;

// Top chrome: a time ruler, then a solid keep/cut summary ribbon (TimeBolt-style).
const RULER_H = 14;
const RIBBON_H = 4;

// TimeBolt look, adapted for the dark editor theme: the *region bands* carry the
// green/red meaning, and a single uniform light waveform is drawn on top. (The
// reference uses a dark wave on pastel bands; on a dark surface we invert to a
// light wave on saturated bands.)
const COLOR_KEEP_BG = "rgba(34, 197, 94, 0.22)"; // green-500
const COLOR_SILENCE_BG = "rgba(239, 68, 68, 0.20)"; // red-500
const COLOR_BLUE_BG = "rgba(59, 130, 246, 0.24)"; // blue-500
const COLOR_RIBBON_KEEP = "rgba(34, 197, 94, 0.95)";
const COLOR_RIBBON_SILENCE = "rgba(239, 68, 68, 0.95)";
const COLOR_RIBBON_BLUE = "rgba(59, 130, 246, 0.95)";
const COLOR_WAVE = "rgba(228, 240, 228, 0.88)"; // uniform light wave over the bands
const COLOR_RULER_TICK = "rgba(255, 255, 255, 0.22)";
const COLOR_RULER_LABEL = "rgba(255, 255, 255, 0.45)";
const COLOR_PLAYHEAD = "rgba(250, 204, 21, 0.95)"; // yellow-400
const COLOR_ACTIVE = "rgba(255, 255, 255, 0.5)"; // current-segment outline
const COLOR_LOCK = "rgba(250, 204, 21, 0.95)"; // lock tick (amber)
const COLOR_MARK = "rgba(168, 85, 247, 0.95)"; // mark tick (purple)
const COLOR_CHAPTER = "rgba(96, 165, 250, 0.98)"; // chapter triangle (blue-400)
const COLOR_FEEDBACK = "rgba(192, 132, 252, 0.98)"; // feedback triangle (purple-400)
// Screen-px radius for grabbing a ruler pin to drag it.
const PIN_HIT_PX = 8;

// Pick a "nice" ruler interval (sec) so labels stay ~70px+ apart.
const NICE_STEPS = [
	0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600,
];
function pickTickStep(pxPerSec: number): number {
	const minPx = 70;
	for (const step of NICE_STEPS) {
		if (step * pxPerSec >= minPx) return step;
	}
	return NICE_STEPS[NICE_STEPS.length - 1];
}
function formatTick(sec: number): string {
	if (sec < 60) return `${sec % 1 === 0 ? sec : sec.toFixed(1)}s`;
	const m = Math.floor(sec / 60);
	const s = Math.round(sec % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Green/red/blue waveform. At zoom = 1 the whole clip fits the visible width
 * (the default "fit entire clip" view). Zooming in (Z/X) widens the virtual
 * content and the view scrolls to keep the playhead centered; the canvas is
 * viewport-clipped under MAX_CANVAS_CSS_WIDTH and slid, like the timeline's
 * AudioWaveform, so deep zoom on a 2hr clip never blows past canvas limits.
 */
export function RawCutWaveform({
	buffer,
	silenceRanges,
	blueRanges,
	markers,
	chapterMarkers,
	feedbackMarkers,
	onChapterRetime,
	onFeedbackRetime,
	editingFeedbackIndex,
	onFeedbackEditOpen,
	onFeedbackNoteChange,
	onFeedbackEditClose,
	onFeedbackDelete,
	editingChapterIndex,
	onChapterEditOpen,
	onChapterNoteChange,
	onChapterEditClose,
	onChapterDelete,
	activeRange,
	currentTime = 0,
	durationSec,
	zoom = 1,
	onSeek,
	onZoomBy,
	className,
}: RawCutWaveformProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	// Chapter pin the cursor is hovering (screen x + title), for the tooltip.
	const [chapterHover, setChapterHover] = useState<{
		x: number;
		title: string;
	} | null>(null);
	const globalMaxRef = useRef<number>(1);
	// Latest zoom callback for the stable wheel closure.
	const onZoomByRef = useRef(onZoomBy);
	onZoomByRef.current = onZoomBy;
	// User horizontal pan (content px). null = follow the playhead; a number =
	// the user side-scrolled here and it holds until the playhead next moves
	// (seek or playback). Lets side-scroll work without a scrollbar.
	const panRef = useRef<number | null>(null);
	// Last currentTime the view reacted to — used to tell a real playhead move
	// (seek / playback → follow) from a static frame (manual pan → hold).
	const lastTimeRef = useRef(currentTime);
	// Persistent view geometry across draws: the visible window's left edge in
	// content px, plus the zoom it was computed at (so a zoom change can anchor
	// on the playhead instead of yanking the view). Read by click-to-seek too.
	const viewRef = useRef({ contentW: 1, scrollLeft: 0, playDur: 1, zoom: 1 });

	// --- Ruler-pin drag (chapters + feedback). The pin being dragged + its live
	// time; read by the draw loop to render it at the cursor. A ref (not state) so
	// the drag survives the draw effect re-running every playback frame; a redraw
	// nonce forces the draw to repaint as the pin moves. ---
	const dragRef = useRef<{
		kind: "chapter" | "feedback";
		index: number;
		sec: number;
	} | null>(null);
	const suppressClickRef = useRef(false);
	const [drawNonce, bumpDraw] = useReducer((x: number) => x + 1, 0);
	// Latest markers + commit callbacks, so the once-mounted pointer effect always
	// hit-tests against current pins without re-binding listeners every render.
	const chapterMarkersRef = useRef(chapterMarkers);
	chapterMarkersRef.current = chapterMarkers;
	const feedbackMarkersRef = useRef(feedbackMarkers);
	feedbackMarkersRef.current = feedbackMarkers;
	const onChapterRetimeRef = useRef(onChapterRetime);
	onChapterRetimeRef.current = onChapterRetime;
	const onFeedbackRetimeRef = useRef(onFeedbackRetime);
	onFeedbackRetimeRef.current = onFeedbackRetime;

	useEffect(() => {
		globalMaxRef.current = computeGlobalMaxRms({ buffer });
	}, [buffer]);

	// Pin drag: pointer-down in the ruler near a chapter/feedback pin grabs it;
	// move re-times it live; up commits via the retime callback. Bound once; reads
	// everything through refs so it never needs re-binding. No-op unless the
	// relevant retime callback is provided (Raw Cut omits both → pins stay static).
	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const secAtClientX = (clientX: number): number => {
			const rect = container.getBoundingClientRect();
			const mx = clientX - rect.left;
			const { contentW, scrollLeft, playDur } = viewRef.current;
			return Math.max(
				0,
				Math.min(playDur, ((mx + scrollLeft) / contentW) * playDur),
			);
		};

		// Nearest grabbable pin to the cursor x, within PIN_HIT_PX, or null.
		const hitPin = (clientX: number) => {
			const rect = container.getBoundingClientRect();
			const mx = clientX - rect.left;
			const { contentW, scrollLeft, playDur } = viewRef.current;
			const screenX = (sec: number) => (sec / playDur) * contentW - scrollLeft;
			let best: {
				kind: "chapter" | "feedback";
				index: number;
				sec: number;
			} | null = null;
			let bestDx = PIN_HIT_PX;
			if (onChapterRetimeRef.current) {
				(chapterMarkersRef.current ?? []).forEach((c, i) => {
					const dx = Math.abs(mx - screenX(c.sec));
					if (dx < bestDx) {
						bestDx = dx;
						best = { kind: "chapter", index: i, sec: c.sec };
					}
				});
			}
			if (onFeedbackRetimeRef.current) {
				(feedbackMarkersRef.current ?? []).forEach((f, i) => {
					const dx = Math.abs(mx - screenX(f.sec));
					if (dx < bestDx) {
						bestDx = dx;
						best = { kind: "feedback", index: i, sec: f.sec };
					}
				});
			}
			return best;
		};

		const onPointerDown = (e: PointerEvent) => {
			const rect = container.getBoundingClientRect();
			// Only the ruler band grabs pins; below it, clicks seek as before.
			if (e.clientY - rect.top > RULER_H + 3) return;
			const hit = hitPin(e.clientX);
			if (!hit) return;
			e.preventDefault();
			dragRef.current = hit;
			try {
				container.setPointerCapture(e.pointerId);
			} catch {
				/* not all pointer types support capture */
			}
			bumpDraw();
		};
		const onPointerMove = (e: PointerEvent) => {
			if (!dragRef.current) return;
			e.preventDefault();
			dragRef.current = { ...dragRef.current, sec: secAtClientX(e.clientX) };
			bumpDraw();
		};
		const onPointerUp = (e: PointerEvent) => {
			const d = dragRef.current;
			if (!d) return;
			dragRef.current = null;
			suppressClickRef.current = true; // swallow the click that follows the drag
			try {
				container.releasePointerCapture(e.pointerId);
			} catch {
				/* ignore */
			}
			if (d.kind === "chapter") onChapterRetimeRef.current?.(d.index, d.sec);
			else onFeedbackRetimeRef.current?.(d.index, d.sec);
			bumpDraw();
		};
		const onPointerCancel = () => {
			if (!dragRef.current) return;
			dragRef.current = null;
			bumpDraw();
		};

		container.addEventListener("pointerdown", onPointerDown);
		container.addEventListener("pointermove", onPointerMove);
		container.addEventListener("pointerup", onPointerUp);
		container.addEventListener("pointercancel", onPointerCancel);
		return () => {
			container.removeEventListener("pointerdown", onPointerDown);
			container.removeEventListener("pointermove", onPointerMove);
			container.removeEventListener("pointerup", onPointerUp);
			container.removeEventListener("pointercancel", onPointerCancel);
		};
	}, []);

	useEffect(() => {
		const canvas = canvasRef.current;
		const container = containerRef.current;
		if (!canvas || !container) return;

		let rafId = 0;
		let lastSignature = "";

		const draw = () => {
			const rect = container.getBoundingClientRect();
			const viewportW = rect.width;
			const cssH = rect.height;
			if (viewportW <= 0 || cssH <= 0) return;

			const bufDur = buffer.duration;
			// Playable timebase (media element). The playhead + click-to-seek live
			// here; the buffer's resampled duration drifts shorter, so using it for
			// the playhead is what made the head run ahead of the audio.
			const playDur =
				durationSec && Number.isFinite(durationSec) && durationSec > 0
					? durationSec
					: bufDur;
			const z = Math.max(1, zoom);
			const contentW = viewportW * z;
			const pxPerSecMedia = contentW / playDur; // playhead / seek
			const pxPerSecBuf = contentW / bufDur; // bars / bands
			const maxScroll = Math.max(0, contentW - viewportW);
			const playheadX = currentTime * pxPerSecMedia;

			const prev = viewRef.current;
			const playheadMoved = Math.abs(currentTime - lastTimeRef.current) > 1e-4;
			lastTimeRef.current = currentTime;
			let scrollLeft: number;
			if (z !== prev.zoom) {
				// Zoom changed → center on the playhead (clamped). Near the clip
				// start this clamps to 0, so the left edge stays at 0:00 instead of
				// jumping forward; mid-clip it centers. Standard NLE zoom feel.
				panRef.current = null;
				scrollLeft = playheadX - viewportW / 2;
			} else if (panRef.current !== null && !playheadMoved) {
				// User side-scrolled and the playhead hasn't moved → hold the pan.
				scrollLeft = panRef.current;
			} else {
				// Follow the playhead: a real move (seek/playback) clears the pan;
				// page only when the playhead runs off the visible window, so it
				// doesn't yank on every frame.
				if (playheadMoved) panRef.current = null;
				scrollLeft = prev.scrollLeft;
				if (playheadX < scrollLeft || playheadX > scrollLeft + viewportW) {
					scrollLeft = playheadX - viewportW * 0.15;
				}
			}
			scrollLeft = Math.max(0, Math.min(maxScroll, scrollLeft));
			// Keep the pan anchor in sync with the clamped value so further wheel
			// deltas accumulate from the real edge.
			if (panRef.current !== null) panRef.current = scrollLeft;
			viewRef.current = { contentW, scrollLeft, playDur, zoom: z };

			// Visible window of the content, with overscan, capped to canvas limit.
			const clipLeft = Math.max(0, scrollLeft - VIEWPORT_OVERSCAN);
			const clipRight = Math.min(
				contentW,
				scrollLeft + viewportW + VIEWPORT_OVERSCAN,
			);
			const drawWidth = Math.min(clipRight - clipLeft, MAX_CANVAS_CSS_WIDTH);
			if (drawWidth <= 0) return;

			const dpr = window.devicePixelRatio || 1;
			// `drawNonce` + the dragged pin's live time are folded in so a pin drag
			// (which bumps the nonce) repaints the canvas as the pin follows the cursor.
			const sig = `${viewportW}|${cssH}|${dpr}|${z.toFixed(3)}|${scrollLeft.toFixed(1)}|${clipLeft.toFixed(1)}|${drawWidth.toFixed(1)}|${silenceRanges.length}|${blueRanges?.length ?? 0}|${markers?.length ?? 0}|${chapterMarkers?.length ?? 0}|${feedbackMarkers?.length ?? 0}|${activeRange?.startSec.toFixed(2) ?? ""}|${currentTime.toFixed(2)}|${drawNonce}|${dragRef.current?.sec.toFixed(2) ?? ""}`;
			if (sig === lastSignature) return;
			lastSignature = sig;

			canvas.width = Math.round(drawWidth * dpr);
			canvas.height = Math.round(cssH * dpr);
			canvas.style.width = `${drawWidth}px`;
			canvas.style.height = `${cssH}px`;
			// Position the clipped canvas within the viewport.
			canvas.style.left = `${clipLeft - scrollLeft}px`;

			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			ctx.setTransform(1, 0, 0, 1, 0, 0);
			ctx.scale(dpr, dpr);
			ctx.clearRect(0, 0, drawWidth, cssH);

			// Buffer-time second → canvas x (bands + waveform share the buffer timebase).
			const cxBuf = (sec: number) => sec * pxPerSecBuf - clipLeft;

			// Layout: [ruler][ribbon][waveform area].
			const waveTop = RULER_H + RIBBON_H;
			const waveH = Math.max(1, cssH - waveTop);
			const centerY = waveTop + waveH / 2;

			// --- Region bands across the waveform area (green keep, red cut, blue). ---
			ctx.fillStyle = COLOR_KEEP_BG;
			ctx.fillRect(0, waveTop, drawWidth, waveH);
			ctx.fillStyle = COLOR_SILENCE_BG;
			for (const s of silenceRanges) {
				ctx.fillRect(
					cxBuf(s.startSec),
					waveTop,
					(s.endSec - s.startSec) * pxPerSecBuf,
					waveH,
				);
			}
			if (blueRanges?.length) {
				ctx.fillStyle = COLOR_BLUE_BG;
				for (const b of blueRanges) {
					ctx.fillRect(
						cxBuf(b.startSec),
						waveTop,
						(b.endSec - b.startSec) * pxPerSecBuf,
						waveH,
					);
				}
			}

			// --- Top summary ribbon: solid keep/cut/blue strip. ---
			ctx.fillStyle = COLOR_RIBBON_KEEP;
			ctx.fillRect(0, RULER_H, drawWidth, RIBBON_H);
			ctx.fillStyle = COLOR_RIBBON_SILENCE;
			for (const s of silenceRanges) {
				ctx.fillRect(
					cxBuf(s.startSec),
					RULER_H,
					(s.endSec - s.startSec) * pxPerSecBuf,
					RIBBON_H,
				);
			}
			if (blueRanges?.length) {
				ctx.fillStyle = COLOR_RIBBON_BLUE;
				for (const b of blueRanges) {
					ctx.fillRect(
						cxBuf(b.startSec),
						RULER_H,
						(b.endSec - b.startSec) * pxPerSecBuf,
						RIBBON_H,
					);
				}
			}

			// --- Time ruler (media timebase, so labels match the playhead). ---
			const tickStep = pickTickStep(pxPerSecMedia);
			const firstSec =
				Math.ceil(clipLeft / pxPerSecMedia / tickStep) * tickStep;
			const lastSec = (clipLeft + drawWidth) / pxPerSecMedia;
			ctx.fillStyle = COLOR_RULER_TICK;
			ctx.font = "10px ui-sans-serif, system-ui, -apple-system, sans-serif";
			ctx.textBaseline = "top";
			for (let sec = firstSec; sec <= lastSec; sec += tickStep) {
				const x = sec * pxPerSecMedia - clipLeft;
				ctx.fillStyle = COLOR_RULER_TICK;
				ctx.fillRect(x, RULER_H - 5, 1, 5);
				ctx.fillStyle = COLOR_RULER_LABEL;
				ctx.fillText(formatTick(sec), x + 3, 1);
			}

			// --- Uniform waveform envelope drawn on top of the bands. ---
			const cols = Math.max(1, Math.floor(drawWidth));
			const startSample = Math.floor((clipLeft / contentW) * buffer.length);
			const endSample = Math.min(
				buffer.length,
				Math.ceil(((clipLeft + drawWidth) / contentW) * buffer.length),
			);
			const peaks = extractRmsRange({
				buffer,
				count: cols,
				startSample,
				endSample,
				globalMax: globalMaxRef.current,
			});
			const maxHalf = (waveH * 0.9) / 2;
			const logMax = Math.log1p(1);
			ctx.beginPath();
			ctx.moveTo(0, centerY);
			for (let i = 0; i < cols; i++) {
				const h = Math.max(0.5, (Math.log1p(peaks[i]) / logMax) * maxHalf);
				ctx.lineTo(i, centerY - h);
			}
			for (let i = cols - 1; i >= 0; i--) {
				const h = Math.max(0.5, (Math.log1p(peaks[i]) / logMax) * maxHalf);
				ctx.lineTo(i, centerY + h);
			}
			ctx.closePath();
			ctx.fillStyle = COLOR_WAVE;
			ctx.fill();

			// --- Current segment outline. ---
			if (activeRange) {
				const x = cxBuf(activeRange.startSec);
				const w = (activeRange.endSec - activeRange.startSec) * pxPerSecBuf;
				ctx.strokeStyle = COLOR_ACTIVE;
				ctx.lineWidth = 1.5;
				ctx.strokeRect(x + 0.75, waveTop + 0.75, w - 1.5, waveH - 1.5);
			}

			// --- Lock / mark ticks at segment starts (in the ribbon row). ---
			if (markers?.length) {
				for (const m of markers) {
					const x = cxBuf(m.sec);
					ctx.fillStyle = m.kind === "lock" ? COLOR_LOCK : COLOR_MARK;
					// lock above the ribbon, mark just below it, so both can show.
					const y = m.kind === "lock" ? 0 : RULER_H + RIBBON_H;
					ctx.fillRect(x - 1, y, 2, RULER_H);
				}
			}

			// --- Playhead — media timebase (matches the audio the user hears). ---
			if (currentTime > 0 && currentTime <= playDur) {
				const x = currentTime * pxPerSecMedia - clipLeft;
				if (x >= 0 && x <= drawWidth) {
					ctx.fillStyle = COLOR_PLAYHEAD;
					ctx.fillRect(x - 0.5, RULER_H, 1.5, cssH - RULER_H);
				}
			}

			// --- Ruler pins: downward triangles in the ruler (media timebase, so
			// they sit on the same scale as the playhead and stay put while
			// zooming/panning). Blue = chapters, purple = feedback. The pin being
			// dragged renders at the live cursor time instead of its stored time. ---
			const drag = dragRef.current;
			const drawPins = (
				list: Array<{ sec: number }> | undefined,
				kind: "chapter" | "feedback",
				color: string,
			) => {
				if (!list?.length) return;
				ctx.fillStyle = color;
				list.forEach((c, i) => {
					const sec =
						drag && drag.kind === kind && drag.index === i ? drag.sec : c.sec;
					const x = sec * pxPerSecMedia - clipLeft;
					if (x < -6 || x > drawWidth + 6) return;
					ctx.beginPath();
					ctx.moveTo(x - 5, 1);
					ctx.lineTo(x + 5, 1);
					ctx.lineTo(x, RULER_H - 1);
					ctx.closePath();
					ctx.fill();
				});
			};
			drawPins(chapterMarkers, "chapter", COLOR_CHAPTER);
			drawPins(feedbackMarkers, "feedback", COLOR_FEEDBACK);
		};

		const schedule = () => {
			if (rafId) return;
			rafId = requestAnimationFrame(() => {
				rafId = 0;
				draw();
			});
		};

		// Wheel: horizontal (Magic Mouse side-scroll / trackpad / Shift+wheel) pans
		// the zoomed view; vertical zooms. No scrollbar.
		const onWheel = (e: WheelEvent) => {
			const absX = Math.abs(e.deltaX);
			const absY = Math.abs(e.deltaY);
			if (absX > absY && absX > 0) {
				const prev = viewRef.current;
				const maxScroll = Math.max(
					0,
					prev.contentW - container.getBoundingClientRect().width,
				);
				if (maxScroll <= 0) return; // nothing to pan (fit-to-width)
				e.preventDefault();
				const base = panRef.current ?? prev.scrollLeft;
				panRef.current = Math.max(0, Math.min(maxScroll, base + e.deltaX));
				schedule();
			} else if (absY > 0) {
				e.preventDefault();
				// Proportional zoom: scroll up zooms in, down zooms out.
				onZoomByRef.current?.(Math.exp(-e.deltaY * 0.0015));
			}
		};

		draw();
		const ro = new ResizeObserver(schedule);
		ro.observe(container);
		window.addEventListener("resize", schedule, { passive: true });
		container.addEventListener("wheel", onWheel, { passive: false });
		return () => {
			ro.disconnect();
			window.removeEventListener("resize", schedule);
			container.removeEventListener("wheel", onWheel);
			if (rafId) cancelAnimationFrame(rafId);
		};
	}, [
		buffer,
		silenceRanges,
		blueRanges,
		markers,
		chapterMarkers,
		feedbackMarkers,
		activeRange,
		currentTime,
		durationSec,
		zoom,
		drawNonce,
	]);

	const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
		// A click fires right after a pin drag ends — swallow it so the drag
		// doesn't also seek the playhead to where the pin landed.
		if (suppressClickRef.current) {
			suppressClickRef.current = false;
			return;
		}
		if (!onSeek) return;
		const rect = e.currentTarget.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const { contentW, scrollLeft, playDur } = viewRef.current;
		const t = ((x + scrollLeft) / contentW) * playDur;
		onSeek(Math.max(0, Math.min(playDur, t)));
	};

	// Hover a chapter triangle → show its title. Uses the live view geometry so it
	// stays correct at any zoom/pan.
	const handleMove = (e: React.MouseEvent<HTMLDivElement>) => {
		const pins = [...(chapterMarkers ?? []), ...(feedbackMarkers ?? [])];
		if (pins.length === 0) {
			if (chapterHover) setChapterHover(null);
			return;
		}
		const rect = e.currentTarget.getBoundingClientRect();
		const mx = e.clientX - rect.left;
		const { contentW, scrollLeft, playDur } = viewRef.current;
		let best: { x: number; title: string } | null = null;
		let bestDx = 8;
		for (const c of pins) {
			const x = (c.sec / playDur) * contentW - scrollLeft;
			const dx = Math.abs(mx - x);
			if (dx < bestDx) {
				bestDx = dx;
				best = { x, title: c.title };
			}
		}
		setChapterHover(best);
	};

	// Double-click a chapter (blue) or feedback (purple) pin → open its inline
	// editor on the timeline (no side panel). Nearest pin within PIN_HIT_PX wins.
	const handleDoubleClick = (e: React.MouseEvent<HTMLDivElement>) => {
		const rect = e.currentTarget.getBoundingClientRect();
		const mx = e.clientX - rect.left;
		const { contentW, scrollLeft, playDur } = viewRef.current;
		const screenX = (sec: number) => (sec / playDur) * contentW - scrollLeft;
		let best: { kind: "chapter" | "feedback"; index: number } | null = null;
		let bestDx = PIN_HIT_PX;
		const cm = chapterMarkers ?? [];
		if (onChapterEditOpen) {
			for (let i = 0; i < cm.length; i++) {
				const dx = Math.abs(mx - screenX(cm[i].sec));
				if (dx < bestDx) {
					bestDx = dx;
					best = { kind: "chapter", index: i };
				}
			}
		}
		const fm = feedbackMarkers ?? [];
		if (onFeedbackEditOpen) {
			for (let i = 0; i < fm.length; i++) {
				const dx = Math.abs(mx - screenX(fm[i].sec));
				if (dx < bestDx) {
					bestDx = dx;
					best = { kind: "feedback", index: i };
				}
			}
		}
		if (best) {
			e.preventDefault();
			if (best.kind === "chapter") onChapterEditOpen?.(best.index);
			else onFeedbackEditOpen?.(best.index);
		}
	};

	// The pin whose inline editor is open (chapter or feedback), with its kind's
	// callbacks + the screen-x to anchor the editor (live view geometry).
	const editing =
		editingChapterIndex != null && chapterMarkers?.[editingChapterIndex]
			? {
					index: editingChapterIndex,
					title: chapterMarkers[editingChapterIndex].title,
					sec: chapterMarkers[editingChapterIndex].sec,
					onChange: onChapterNoteChange,
					onClose: onChapterEditClose,
					onDelete: onChapterDelete,
					placeholder: "Chapter title",
				}
			: editingFeedbackIndex != null && feedbackMarkers?.[editingFeedbackIndex]
				? {
						index: editingFeedbackIndex,
						title: feedbackMarkers[editingFeedbackIndex].title,
						sec: feedbackMarkers[editingFeedbackIndex].sec,
						onChange: onFeedbackNoteChange,
						onClose: onFeedbackEditClose,
						onDelete: onFeedbackDelete,
						placeholder: "What needs fixing here?",
					}
				: null;
	const editX = editing
		? (editing.sec / viewRef.current.playDur) * viewRef.current.contentW -
			viewRef.current.scrollLeft
		: 0;

	return (
		<div
			ref={containerRef}
			className={cn(
				"relative h-full w-full cursor-pointer overflow-hidden rounded border",
				className,
			)}
			onClick={handleClick}
			onDoubleClick={handleDoubleClick}
			onMouseMove={handleMove}
			onMouseLeave={() => setChapterHover(null)}
			onKeyDown={() => {}}
			role="slider"
			aria-label="Raw Cut waveform"
			aria-valuemin={0}
			aria-valuemax={durationSec ?? buffer.duration}
			aria-valuenow={currentTime}
			tabIndex={0}
		>
			<canvas ref={canvasRef} className="absolute top-0 left-0" />
			{chapterHover && !editing && (
				<div
					className="pointer-events-none absolute z-10 -translate-x-1/2 whitespace-nowrap rounded bg-black/85 px-1.5 py-0.5 text-xs text-white"
					style={{ left: chapterHover.x, top: RULER_H + 2 }}
				>
					{chapterHover.title}
				</div>
			)}
			{editing && (
				<div
					key={editing.index}
					className="absolute z-20 flex -translate-x-1/2 items-center gap-1"
					style={{ left: editX, top: RULER_H + 2 }}
				>
					<input
						// biome-ignore lint/a11y/noAutofocus: the editor only opens on explicit intent (M / N / double-click)
						autoFocus
						value={editing.title}
						onChange={(e) => editing.onChange?.(editing.index, e.target.value)}
						// stop seek/drag from the waveform underneath.
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => {
							if (e.key === "Enter" || e.key === "Escape") {
								e.preventDefault();
								editing.onClose?.();
							}
						}}
						onBlur={() => editing.onClose?.()}
						placeholder={editing.placeholder}
						className="w-56 rounded border border-purple-400/70 bg-black/90 px-2 py-0.5 text-xs text-white focus:outline-none"
					/>
					<button
						type="button"
						// mousedown (not click) so it fires before the input's blur closes the editor
						onMouseDown={(e) => {
							e.preventDefault();
							editing.onDelete?.(editing.index);
						}}
						onClick={(e) => e.stopPropagation()}
						title="Delete"
						className="rounded bg-black/90 px-1.5 py-0.5 text-xs text-white/70 hover:text-red-400"
					>
						✕
					</button>
				</div>
			)}
		</div>
	);
}
