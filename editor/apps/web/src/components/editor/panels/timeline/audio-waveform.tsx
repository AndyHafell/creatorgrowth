"use client";

import { useEffect, useRef, useState } from "react";
import { computeGlobalMaxRms, extractRmsRange } from "@/lib/media/audio";
import {
	WAVEFORM_BLOCK_SIZE,
	buildWaveformBlockCache,
	computeWaveformSampleWindow,
	extractPeaksFromBlockCache,
} from "@/lib/media/rms";
import { findScrollParent } from "@/utils/browser";
import { cn } from "@/utils/ui";

const BAR_WIDTH = 2;
const BAR_GAP = 1;
const BAR_STEP = BAR_WIDTH + BAR_GAP;
// Safely under all browser canvas limits (Safari iOS is ~4k, desktop ~16k/32k).
const MAX_CANVAS_CSS_WIDTH = 6000;
// Overscan past the viewport edges so quick scrolls don't reveal blank canvas
// before the next redraw fires.
const VIEWPORT_OVERSCAN = 400;

// Waveform display only needs a coarse RMS envelope, so decode at a low sample
// rate to keep memory tiny (a full-res 2hr decode is ~GBs).
const WAVEFORM_SAMPLE_RATE = 8000;

// Decode each source URL ONCE and share the buffer across every clip that
// references it. Without this, hundreds of audio clips off one long source each
// fetch + decode the whole file → the tab runs out of memory and crashes. Keyed
// by URL, module scope so it persists across clip mounts.
const waveformDecodeCache = new Map<string, Promise<AudioBuffer | null>>();

function getSharedWaveformBuffer(url: string): Promise<AudioBuffer | null> {
	let pending = waveformDecodeCache.get(url);
	if (!pending) {
		pending = (async () => {
			try {
				const resp = await fetch(url);
				if (!resp.ok) {
					console.warn("[waveform] fetch failed", url, resp.status);
					return null;
				}
				const arr = await resp.arrayBuffer();
				// decodeAudioData on an OfflineAudioContext resamples to its rate, so
				// this both decodes and downsamples in one pass.
				const octx = new OfflineAudioContext({
					numberOfChannels: 1,
					length: 1,
					sampleRate: WAVEFORM_SAMPLE_RATE,
				});
				return await octx.decodeAudioData(arr);
			} catch (err) {
				console.warn("[waveform] decode failed", url, err);
				waveformDecodeCache.delete(url); // allow a retry on remount
				return null;
			}
		})();
		waveformDecodeCache.set(url, pending);
	}
	return pending;
}

// Per-buffer derived data, computed once and shared by every clip that
// references the same source. The block cache turns each redraw into an
// O(blocks-in-range) read instead of a raw-sample scan — with dozens of Raw
// Cut clips over one 13-min source, the raw scans were the X/Z zoom hitch.
const globalMaxCache = new WeakMap<AudioBuffer, number>();
const blockCacheByBuffer = new WeakMap<AudioBuffer, Float32Array>();

function getGlobalMax(buffer: AudioBuffer): number {
	let max = globalMaxCache.get(buffer);
	if (max === undefined) {
		max = computeGlobalMaxRms({ buffer });
		globalMaxCache.set(buffer, max);
	}
	return max;
}

function getBlockCache(buffer: AudioBuffer): Float32Array {
	let cache = blockCacheByBuffer.get(buffer);
	if (!cache) {
		cache = buildWaveformBlockCache({ buffer });
		blockCacheByBuffer.set(buffer, cache);
	}
	return cache;
}

// Below this many samples per bar, block granularity could visibly smear
// detail — fall back to the exact raw-sample scan (cheap at that zoom: the
// visible range is tiny by definition).
const BLOCK_PATH_MIN_SAMPLES_PER_BAR = WAVEFORM_BLOCK_SIZE * 4;

interface AudioWaveformProps {
	audioUrl?: string;
	audioBuffer?: AudioBuffer;
	/** Source-time offset (seconds) where this clip's window starts. */
	trimStartSec?: number;
	/** Timeline duration (seconds) the clip's full width represents. */
	visibleDurationSec?: number;
	playbackRate?: number;
	color?: string;
	className?: string;
}

/**
 * RMS-bar waveform sized to the clip's full container width but rendered into
 * a viewport-clipped canvas. For short clips this draws the entire thing; for
 * very long / heavily-zoomed clips we keep the canvas under MAX_CANVAS_CSS_WIDTH
 * and slide it as the user scrolls the timeline.
 */
export function AudioWaveform({
	audioUrl,
	audioBuffer,
	trimStartSec,
	visibleDurationSec,
	playbackRate,
	color = "rgba(255, 255, 255, 0.85)",
	className = "",
}: AudioWaveformProps) {
	const canvasRef = useRef<HTMLCanvasElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);
	const [buffer, setBuffer] = useState<AudioBuffer | null>(audioBuffer ?? null);
	const globalMaxRef = useRef<number>(1);

	useEffect(() => {
		let cancelled = false;
		if (audioBuffer) {
			setBuffer(audioBuffer);
			globalMaxRef.current = getGlobalMax(audioBuffer);
			return;
		}
		if (!audioUrl) {
			setBuffer(null);
			return;
		}
		getSharedWaveformBuffer(audioUrl).then((decoded) => {
			if (cancelled || !decoded) return;
			globalMaxRef.current = getGlobalMax(decoded);
			setBuffer(decoded);
		});
		return () => {
			cancelled = true;
		};
	}, [audioUrl, audioBuffer]);

	useEffect(() => {
		const canvas = canvasRef.current;
		const container = containerRef.current;
		if (!canvas || !container || !buffer) return;

		let cancelled = false;
		let rafId = 0;
		let lastSignature = "";

		const scrollParent = findScrollParent({ element: container });

		const draw = () => {
			if (cancelled) return;
			const containerRect = container.getBoundingClientRect();
			const cssH = containerRect.height;
			const fullW = container.offsetWidth;
			if (cssH <= 0 || fullW <= 0) return;

			// Visible portion of the clip relative to the scroll parent (or
			// window when no scroll parent).
			let viewportLeft: number;
			let viewportRight: number;
			if (scrollParent) {
				const pr = scrollParent.getBoundingClientRect();
				viewportLeft = pr.left;
				viewportRight = pr.right;
			} else {
				viewportLeft = 0;
				viewportRight = window.innerWidth;
			}
			const clipLeftInClip = Math.max(
				0,
				viewportLeft - containerRect.left - VIEWPORT_OVERSCAN,
			);
			const clipRightInClip = Math.min(
				fullW,
				viewportRight - containerRect.left + VIEWPORT_OVERSCAN,
			);
			let drawWidth = clipRightInClip - clipLeftInClip;
			if (drawWidth <= 0) {
				// Off-screen — nothing to draw, just blank the canvas so stale
				// bars don't linger when we scroll past.
				const ctx = canvas.getContext("2d");
				if (ctx) ctx.clearRect(0, 0, canvas.width, canvas.height);
				return;
			}
			drawWidth = Math.min(drawWidth, MAX_CANVAS_CSS_WIDTH);

			// De-dup: only redraw if size or position actually changed.
			const signature = `${clipLeftInClip}|${drawWidth}|${cssH}|${fullW}`;
			if (signature === lastSignature) return;
			lastSignature = signature;

			const dpr = window.devicePixelRatio || 1;
			canvas.width = Math.round(drawWidth * dpr);
			canvas.height = Math.round(cssH * dpr);
			canvas.style.width = `${drawWidth}px`;
			canvas.style.height = `${cssH}px`;
			canvas.style.left = `${clipLeftInClip}px`;

			const ctx = canvas.getContext("2d");
			if (!ctx) return;
			ctx.clearRect(0, 0, canvas.width, canvas.height);
			ctx.scale(dpr, dpr);
			ctx.fillStyle = color;

			const barCount = Math.max(1, Math.floor(drawWidth / BAR_STEP));
			// Map this clip's pixels onto ITS source window. Without trim props
			// (legacy callers) the window is the whole buffer, matching the old
			// mapping for untrimmed clips.
			const effTrimStart = trimStartSec ?? 0;
			const effVisibleDuration =
				visibleDurationSec ??
				Math.max(0, buffer.length / buffer.sampleRate - effTrimStart);
			const { startSample, endSample } = computeWaveformSampleWindow({
				bufferLength: buffer.length,
				sampleRate: buffer.sampleRate,
				trimStartSec: effTrimStart,
				visibleDurationSec: effVisibleDuration,
				playbackRate: playbackRate ?? 1,
				clipLeftPx: clipLeftInClip,
				drawWidthPx: drawWidth,
				fullWidthPx: fullW,
			});
			const samplesPerBar = (endSample - startSample) / barCount;
			const peaks =
				samplesPerBar >= BLOCK_PATH_MIN_SAMPLES_PER_BAR
					? extractPeaksFromBlockCache({
							blockMax: getBlockCache(buffer),
							blockSize: WAVEFORM_BLOCK_SIZE,
							count: barCount,
							startSample,
							endSample,
							globalMax: globalMaxRef.current,
						})
					: extractRmsRange({
							buffer,
							count: barCount,
							startSample,
							endSample,
							globalMax: globalMaxRef.current,
						});
			const maxBarHeight = cssH * 0.85;
			const centerY = cssH / 2;
			for (let i = 0; i < barCount; i++) {
				const scaled = Math.log1p(peaks[i]) / Math.log1p(1);
				const barH = Math.max(1, scaled * maxBarHeight);
				ctx.fillRect(i * BAR_STEP, centerY - barH / 2, BAR_WIDTH, barH);
			}
		};

		const scheduleDraw = () => {
			if (rafId) return;
			rafId = requestAnimationFrame(() => {
				rafId = 0;
				draw();
			});
		};

		draw();
		const observer = new ResizeObserver(scheduleDraw);
		observer.observe(container);
		if (scrollParent) {
			scrollParent.addEventListener("scroll", scheduleDraw, { passive: true });
		}
		window.addEventListener("resize", scheduleDraw, { passive: true });

		return () => {
			cancelled = true;
			if (rafId) cancelAnimationFrame(rafId);
			observer.disconnect();
			if (scrollParent) {
				scrollParent.removeEventListener("scroll", scheduleDraw);
			}
			window.removeEventListener("resize", scheduleDraw);
		};
	}, [buffer, color, trimStartSec, visibleDurationSec, playbackRate]);

	return (
		<div ref={containerRef} className={cn("relative size-full", className)}>
			<canvas ref={canvasRef} className="absolute top-0" />
		</div>
	);
}
