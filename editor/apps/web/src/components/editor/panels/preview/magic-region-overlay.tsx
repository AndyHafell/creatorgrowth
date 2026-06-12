"use client";

import { useCallback, useRef } from "react";
import { usePreviewViewport } from "@/components/editor/panels/preview/preview-viewport";
import { useEditor } from "@/hooks/use-editor";
import { useElementPreview } from "@/hooks/use-element-preview";
import { effectsRegistry } from "@/lib/effects";
import { zoomWindowRect } from "@/lib/effects/camera";
import { MAGIC_REFRAME_PRESETS } from "@/lib/effects/definitions/magic-reframe";
import type { EffectElement } from "@/lib/timeline";

type RectPct = { x: number; y: number; w: number; h: number };
type MagicKind = "camera" | "highlight";
type DragMode = "move" | "resize-nw" | "resize-ne" | "resize-sw" | "resize-se";

function clampPct(v: number, lo = 0, hi = 100): number {
	return Math.min(hi, Math.max(lo, v));
}

export function MagicRegionOverlay() {
	const editor = useEditor();
	const selectedElements = useEditor((e) => e.selection.getSelectedElements());

	const selectedRef =
		selectedElements.length === 1 ? selectedElements[0] : null;
	const track = selectedRef
		? editor.timeline.getTrackById({ trackId: selectedRef.trackId })
		: null;
	const element =
		track?.elements.find((el) => el.id === selectedRef?.elementId) ?? null;

	if (!element || element.type !== "effect" || !selectedRef) return null;
	const definition = effectsRegistry.has(element.effectType)
		? effectsRegistry.get(element.effectType)
		: null;
	const kind = definition?.kind ?? "passes";
	if (kind !== "camera" && kind !== "highlight") return null;

	return (
		<RegionEditor
			key={element.id}
			element={element as EffectElement}
			trackId={selectedRef.trackId}
			kind={kind}
		/>
	);
}

function RegionEditor({
	element,
	trackId,
	kind,
}: {
	element: EffectElement;
	trackId: string;
	kind: MagicKind;
}) {
	const viewport = usePreviewViewport();
	const { renderElement, previewUpdates, commit } = useElementPreview({
		trackId,
		elementId: element.id,
		fallback: element,
	});
	const params = (renderElement as EffectElement).params;
	const containerRef = useRef<HTMLDivElement>(null);
	const dragRef = useRef<{
		mode: DragMode;
		startX: number;
		startY: number;
		startRect: RectPct;
	} | null>(null);

	const num = useCallback(
		(key: string, fallback: number): number =>
			typeof params[key] === "number" ? (params[key] as number) : fallback,
		[params],
	);

	const rect: RectPct =
		kind === "camera"
			? zoomWindowRect({
					scale: num("scale", 1.8),
					focalX: num("focalX", 50) / 100,
					focalY: num("focalY", 50) / 100,
					canvasWidth: 100,
					canvasHeight: 100,
				})
			: {
					x: num("regionX", 25),
					y: num("regionY", 25),
					w: num("regionW", 50),
					h: num("regionH", 50),
				};

	const writeRect = useCallback(
		(next: RectPct, final: boolean) => {
			const updated =
				kind === "camera"
					? {
							...params,
							focalX: clampPct(next.x + next.w / 2),
							focalY: clampPct(next.y + next.h / 2),
							scale: Math.min(4, Math.max(1, 100 / Math.max(next.w, 25))),
						}
					: {
							...params,
							regionX: clampPct(next.x, 0, 100 - next.w),
							regionY: clampPct(next.y, 0, 100 - next.h),
							regionW: clampPct(next.w, 2),
							regionH: clampPct(next.h, 2),
						};
			previewUpdates({ params: updated });
			if (final) commit();
		},
		[kind, params, previewUpdates, commit],
	);

	const rectFromDrag = useCallback(
		(event: React.PointerEvent): RectPct | null => {
			const drag = dragRef.current;
			const container = containerRef.current;
			if (!drag || !container) return null;
			const bounds = container.getBoundingClientRect();
			const dx = ((event.clientX - drag.startX) / bounds.width) * 100;
			const dy = ((event.clientY - drag.startY) / bounds.height) * 100;
			const start = drag.startRect;

			if (drag.mode === "move") {
				return {
					...start,
					x: clampPct(start.x + dx, 0, 100 - start.w),
					y: clampPct(start.y + dy, 0, 100 - start.h),
				};
			}

			// resize: the dragged corner moves, the opposite corner stays fixed
			const fixedX = drag.mode.includes("w") ? start.x + start.w : start.x;
			const fixedY = drag.mode.includes("n") ? start.y + start.h : start.y;
			const movingX =
				(drag.mode.includes("w") ? start.x : start.x + start.w) + dx;
			const movingY =
				(drag.mode.includes("n") ? start.y : start.y + start.h) + dy;

			let w = Math.abs(movingX - fixedX);
			let h = Math.abs(movingY - fixedY);
			if (kind === "camera") {
				// zoom window aspect is locked to the canvas: equal percent on both axes
				w = Math.max(w, h);
				w = clampPct(w, 25, 100); // scale 1..4
				h = w;
			} else {
				w = clampPct(w, 2);
				h = clampPct(h, 2);
			}
			return {
				x: clampPct(Math.min(fixedX, movingX < fixedX ? fixedX - w : fixedX)),
				y: clampPct(Math.min(fixedY, movingY < fixedY ? fixedY - h : fixedY)),
				w,
				h,
			};
		},
		[kind],
	);

	const onPointerDown = useCallback(
		(mode: DragMode) => (event: React.PointerEvent) => {
			event.stopPropagation();
			event.preventDefault();
			(event.target as HTMLElement).setPointerCapture(event.pointerId);
			dragRef.current = {
				mode,
				startX: event.clientX,
				startY: event.clientY,
				startRect: rect,
			};
		},
		[rect],
	);

	const onPointerMove = useCallback(
		(event: React.PointerEvent) => {
			if (!dragRef.current) return;
			const next = rectFromDrag(event);
			if (next) writeRect(next, false);
		},
		[rectFromDrag, writeRect],
	);

	const onPointerUp = useCallback(
		(event: React.PointerEvent) => {
			if (!dragRef.current) return;
			const next = rectFromDrag(event);
			dragRef.current = null;
			if (next) writeRect(next, true);
		},
		[rectFromDrag, writeRect],
	);

	const isReframe = element.effectType === "magic-reframe";
	const label = isReframe
		? "Magic Reframe"
		: kind === "camera"
			? "Magic Zoom"
			: "Highlight region";

	const applyPreset = useCallback(
		(preset: (typeof MAGIC_REFRAME_PRESETS)[number]) => {
			previewUpdates({
				params: {
					...params,
					scale: preset.scale,
					focalX: preset.focalX,
					focalY: preset.focalY,
				},
			});
			commit();
		},
		[params, previewUpdates, commit],
	);
	const handles: Array<{ mode: DragMode; className: string }> = [
		{ mode: "resize-nw", className: "-top-1.5 -left-1.5 cursor-nwse-resize" },
		{ mode: "resize-ne", className: "-top-1.5 -right-1.5 cursor-nesw-resize" },
		{
			mode: "resize-sw",
			className: "-bottom-1.5 -left-1.5 cursor-nesw-resize",
		},
		{
			mode: "resize-se",
			className: "-bottom-1.5 -right-1.5 cursor-nwse-resize",
		},
	];

	return (
		<div
			ref={containerRef}
			className="pointer-events-none absolute overflow-hidden"
			style={{
				left: viewport.sceneLeft,
				top: viewport.sceneTop,
				width: viewport.sceneWidth,
				height: viewport.sceneHeight,
			}}
		>
			{isReframe && (
				<div className="pointer-events-auto absolute top-2 left-1/2 flex -translate-x-1/2 gap-1">
					{MAGIC_REFRAME_PRESETS.map((preset) => (
						<button
							key={preset.label}
							type="button"
							className="rounded-sm bg-black/70 px-2 py-1 font-medium text-[11px] text-amber-300 hover:bg-amber-400 hover:text-black"
							onClick={() => applyPreset(preset)}
						>
							{preset.label}
						</button>
					))}
				</div>
			)}
			<div
				className="pointer-events-auto absolute cursor-move border-2 border-amber-400"
				style={{
					left: `${rect.x}%`,
					top: `${rect.y}%`,
					width: `${rect.w}%`,
					height: `${rect.h}%`,
					boxShadow: "0 0 0 9999px rgb(0 0 0 / 0.35)",
				}}
				onPointerDown={onPointerDown("move")}
				onPointerMove={onPointerMove}
				onPointerUp={onPointerUp}
			>
				<div className="absolute -top-6 left-0 whitespace-nowrap rounded-sm bg-amber-400 px-1.5 py-0.5 font-medium text-[10px] text-black">
					{label}
				</div>
				{handles.map((handle) => (
					<div
						key={handle.mode}
						className={`absolute size-3 rounded-full border border-black/40 bg-amber-400 ${handle.className}`}
						style={{ pointerEvents: "auto" }}
						onPointerDown={onPointerDown(handle.mode)}
						onPointerMove={onPointerMove}
						onPointerUp={onPointerUp}
					/>
				))}
			</div>
		</div>
	);
}
