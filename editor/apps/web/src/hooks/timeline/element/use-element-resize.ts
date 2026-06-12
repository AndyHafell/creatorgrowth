import { useState, useEffect, useRef, useCallback } from "react";
import { BASE_TIMELINE_PIXELS_PER_SECOND } from "@/lib/timeline/scale";
import { TICKS_PER_SECOND } from "@/lib/wasm";
import { roundToFrame } from "opencut-wasm";
import type { TimelineElement, TimelineTrack } from "@/lib/timeline";
import { useEditor } from "@/hooks/use-editor";
import { useShiftKey } from "@/hooks/use-shift-key";
import {
	findSnapPoints,
	snapToNearestPoint,
	type SnapPoint,
} from "@/lib/timeline/snap-utils";
import { isRetimableElement } from "@/lib/timeline";
import {
	getSourceSpanAtClipTime,
	getTimelineDurationForSourceSpan,
} from "@/lib/retime";
import { useTimelineStore } from "@/stores/timeline-store";
import { registerCanceller } from "@/lib/cancel-interaction";

export interface ResizeState {
	elementId: string;
	side: "left" | "right";
	startX: number;
	initialTrimStart: number;
	initialTrimEnd: number;
	initialStartTime: number;
	initialDuration: number;
}

/** Two clips whose edges sit within 10ms count as one cut for roll edits. */
const ROLL_ABUT_EPSILON = Math.round(TICKS_PER_SECOND * 0.01);

interface UseTimelineElementResizeProps {
	element: TimelineElement;
	track: TimelineTrack;
	zoomLevel: number;
	onSnapPointChange?: (snapPoint: SnapPoint | null) => void;
	onResizeStateChange?: (params: { isResizing: boolean }) => void;
}

export function useTimelineElementResize({
	element,
	track,
	zoomLevel,
	onSnapPointChange,
	onResizeStateChange,
}: UseTimelineElementResizeProps) {
	const editor = useEditor();
	const isShiftHeldRef = useShiftKey();
	const snappingEnabled = useTimelineStore((state) => state.snappingEnabled);
	const rollEditingEnabled = useTimelineStore(
		(state) => state.rollEditingEnabled,
	);

	const [resizing, setResizing] = useState<ResizeState | null>(null);
	const [currentTrimStart, setCurrentTrimStart] = useState(element.trimStart);
	const [currentTrimEnd, setCurrentTrimEnd] = useState(element.trimEnd);
	const [currentStartTime, setCurrentStartTime] = useState(element.startTime);
	const [currentDuration, setCurrentDuration] = useState(element.duration);
	const currentTrimStartRef = useRef(element.trimStart);
	const currentTrimEndRef = useRef(element.trimEnd);
	const currentStartTimeRef = useRef(element.startTime);
	const currentDurationRef = useRef(element.duration);

	const handleResizeStart = ({
		event,
		elementId,
		side,
	}: {
		event: React.MouseEvent;
		elementId: string;
		side: "left" | "right";
	}) => {
		event.stopPropagation();
		event.preventDefault();

		setResizing({
			elementId,
			side,
			startX: event.clientX,
			initialTrimStart: element.trimStart,
			initialTrimEnd: element.trimEnd,
			initialStartTime: element.startTime,
			initialDuration: element.duration,
		});

		setCurrentTrimStart(element.trimStart);
		setCurrentTrimEnd(element.trimEnd);
		setCurrentStartTime(element.startTime);
		setCurrentDuration(element.duration);
		currentTrimStartRef.current = element.trimStart;
		currentTrimEndRef.current = element.trimEnd;
		currentStartTimeRef.current = element.startTime;
		currentDurationRef.current = element.duration;
		onResizeStateChange?.({ isResizing: true });
	};

	const canExtendElementDuration = useCallback(() => {
		return element.sourceDuration == null;
	}, [element.sourceDuration]);

	const getSourceDeltaForClipDelta = useCallback(
		(clipDelta: number) => {
			if (!isRetimableElement(element)) {
				return clipDelta;
			}

			return clipDelta >= 0
				? getSourceSpanAtClipTime({
						clipTime: clipDelta,
						retime: element.retime,
					})
				: -getSourceSpanAtClipTime({
						clipTime: Math.abs(clipDelta),
						retime: element.retime,
					});
		},
		[element],
	);

	const getVisibleSourceSpanForDuration = useCallback(
		(duration: number) => {
			if (!isRetimableElement(element)) {
				return duration;
			}

			return getSourceSpanAtClipTime({
				clipTime: duration,
				retime: element.retime,
			});
		},
		[element],
	);

	const getDurationForVisibleSourceSpan = useCallback(
		(sourceSpan: number) => {
			if (!isRetimableElement(element)) {
				return sourceSpan;
			}

			return getTimelineDurationForSourceSpan({
				sourceSpan,
				retime: element.retime,
			});
		},
		[element],
	);

	const getSourceDuration = useCallback(
		({
			trimStart,
			duration,
			trimEnd,
		}: {
			trimStart: number;
			duration: number;
			trimEnd: number;
		}) => {
			if (typeof element.sourceDuration === "number") {
				return element.sourceDuration;
			}

			return trimStart + getVisibleSourceSpanForDuration(duration) + trimEnd;
		},
		[element.sourceDuration, getVisibleSourceSpanForDuration],
	);

	const cancelResize = useCallback(() => {
		if (!resizing) return;

		setCurrentTrimStart(resizing.initialTrimStart);
		setCurrentTrimEnd(resizing.initialTrimEnd);
		setCurrentStartTime(resizing.initialStartTime);
		setCurrentDuration(resizing.initialDuration);
		currentTrimStartRef.current = resizing.initialTrimStart;
		currentTrimEndRef.current = resizing.initialTrimEnd;
		currentStartTimeRef.current = resizing.initialStartTime;
		currentDurationRef.current = resizing.initialDuration;
		setResizing(null);
		onResizeStateChange?.({ isResizing: false });
		onSnapPointChange?.(null);
	}, [resizing, onResizeStateChange, onSnapPointChange]);

	useEffect(() => {
		if (!resizing) return;

		return registerCanceller({ fn: cancelResize });
	}, [resizing, cancelResize]);

	const updateTrimFromMouseMove = useCallback(
		({ clientX }: { clientX: number }) => {
			if (!resizing) return;

		const deltaX = clientX - resizing.startX;
		let deltaTime = Math.round(
			(deltaX / (BASE_TIMELINE_PIXELS_PER_SECOND * zoomLevel)) * TICKS_PER_SECOND,
		);
		let resizeSnapPoint: SnapPoint | null = null;

		const projectFps = editor.project.getActive().settings.fps;
		const minDuration = Math.round(TICKS_PER_SECOND * projectFps.denominator / projectFps.numerator);
			const shouldSnap = snappingEnabled && !isShiftHeldRef.current;
			if (shouldSnap) {
				const tracks = editor.scenes.getActiveScene().tracks;
				const playheadTime = editor.playback.getCurrentTime();
				const snapPoints = findSnapPoints({
					tracks,
					playheadTime,
					excludeElementId: element.id,
				});
				if (resizing.side === "left") {
					const targetStartTime = resizing.initialStartTime + deltaTime;
					const snapResult = snapToNearestPoint({
						targetTime: targetStartTime,
						snapPoints,
						zoomLevel,
					});
					resizeSnapPoint = snapResult.snapPoint;
					if (snapResult.snapPoint) {
						deltaTime = snapResult.snappedTime - resizing.initialStartTime;
					}
				} else {
					const baseEndTime =
						resizing.initialStartTime + resizing.initialDuration;
					const targetEndTime = baseEndTime + deltaTime;
					const snapResult = snapToNearestPoint({
						targetTime: targetEndTime,
						snapPoints,
						zoomLevel,
					});
					resizeSnapPoint = snapResult.snapPoint;
					if (snapResult.snapPoint) {
						deltaTime = snapResult.snappedTime - baseEndTime;
					}
				}
			}
			onSnapPointChange?.(resizeSnapPoint);

			const otherElements = track.elements.filter(
				({ id }) => id !== element.id,
			);
			const initialEndTime =
				resizing.initialStartTime + resizing.initialDuration;

			// Roll edit: an abutting neighbor is not a wall — the cut between
			// the two clips moves, so the drag may push into the neighbor up to
			// one frame short of its far edge. The neighbor's own geometry gets
			// the complementary patch on commit.
			const rollRightNeighbor =
				rollEditingEnabled && resizing.side === "right"
					? otherElements.find(
							({ startTime }) =>
								Math.abs(startTime - initialEndTime) <= ROLL_ABUT_EPSILON,
						)
					: undefined;
			const rollLeftNeighbor =
				rollEditingEnabled && resizing.side === "left"
					? otherElements.find(
							({ startTime, duration }) =>
								Math.abs(
									startTime + duration - resizing.initialStartTime,
								) <= ROLL_ABUT_EPSILON,
						)
					: undefined;

			const rightNeighborBound =
				resizing.side === "right"
					? rollRightNeighbor
						? rollRightNeighbor.startTime +
							rollRightNeighbor.duration -
							minDuration
						: otherElements
								.filter(({ startTime }) => startTime >= initialEndTime)
								.reduce(
									(min, { startTime }) => Math.min(min, startTime),
									Infinity,
								)
					: Infinity;

			const leftNeighborBound =
				resizing.side === "left"
					? rollLeftNeighbor
						? rollLeftNeighbor.startTime + minDuration
						: otherElements
								.filter(
									({ startTime, duration }) =>
										startTime + duration <= resizing.initialStartTime,
								)
								.reduce(
									(max, { startTime, duration }) =>
										Math.max(max, startTime + duration),
									-Infinity,
								)
					: -Infinity;

			if (resizing.side === "left") {
				const sourceDuration = getSourceDuration({
					trimStart: resizing.initialTrimStart,
					duration: resizing.initialDuration,
					trimEnd: resizing.initialTrimEnd,
				});
				const minTrimStartForNeighbor = Number.isFinite(leftNeighborBound)
					? Math.max(
							0,
							resizing.initialTrimStart +
								getSourceDeltaForClipDelta(
									leftNeighborBound - resizing.initialStartTime,
								),
						)
					: 0;
				const maxAllowed =
					sourceDuration -
					resizing.initialTrimEnd -
					getVisibleSourceSpanForDuration(minDuration);
				const calculated =
					resizing.initialTrimStart + getSourceDeltaForClipDelta(deltaTime);

				if (calculated >= 0 && calculated <= maxAllowed) {
				const newTrimStart = roundToFrame({ time: Math.min(maxAllowed, Math.max(minTrimStartForNeighbor, calculated)), rate: projectFps }) ?? Math.min(maxAllowed, Math.max(minTrimStartForNeighbor, calculated));
					const visibleSourceSpan = Math.max(
						0,
						sourceDuration - newTrimStart - resizing.initialTrimEnd,
					);
				const newDuration = roundToFrame({ time: getDurationForVisibleSourceSpan(visibleSourceSpan), rate: projectFps }) ?? getDurationForVisibleSourceSpan(visibleSourceSpan);
				const trimDelta = resizing.initialDuration - newDuration;
				const newStartTime = roundToFrame({ time: resizing.initialStartTime + trimDelta, rate: projectFps }) ?? resizing.initialStartTime + trimDelta;

					setCurrentTrimStart(newTrimStart);
					setCurrentStartTime(newStartTime);
					setCurrentDuration(newDuration);
					currentTrimStartRef.current = newTrimStart;
					currentStartTimeRef.current = newStartTime;
					currentDurationRef.current = newDuration;
				} else if (calculated < 0) {
					if (canExtendElementDuration()) {
						const extensionAmount = Math.abs(calculated);
						const maxExtension = resizing.initialStartTime;
						const actualExtension = Math.max(
							0,
							Number.isFinite(leftNeighborBound)
								? Math.min(
										extensionAmount,
										maxExtension,
										resizing.initialStartTime - leftNeighborBound,
									)
								: Math.min(extensionAmount, maxExtension),
						);
					const newStartTime = roundToFrame({ time: resizing.initialStartTime - actualExtension, rate: projectFps }) ?? resizing.initialStartTime - actualExtension;
					const newDuration = roundToFrame({ time: resizing.initialDuration + actualExtension, rate: projectFps }) ?? resizing.initialDuration + actualExtension;

						setCurrentTrimStart(0);
						setCurrentStartTime(newStartTime);
						setCurrentDuration(newDuration);
						currentTrimStartRef.current = 0;
						currentStartTimeRef.current = newStartTime;
						currentDurationRef.current = newDuration;
					} else {
						const leftBound = Number.isFinite(leftNeighborBound)
							? leftNeighborBound
							: 0;
						const trimDeltaFromTrimStart =
							minTrimStartForNeighbor - resizing.initialTrimStart;
						const trimDeltaFromStartTime = getSourceDeltaForClipDelta(
							leftBound - resizing.initialStartTime,
						);
						const trimDelta = Math.max(
							trimDeltaFromTrimStart,
							trimDeltaFromStartTime,
						);
						const newTrimStart = resizing.initialTrimStart + trimDelta;
						const visibleSourceSpan = Math.max(
							0,
							sourceDuration - newTrimStart - resizing.initialTrimEnd,
						);
					const newDuration = roundToFrame({ time: getDurationForVisibleSourceSpan(visibleSourceSpan), rate: projectFps }) ?? getDurationForVisibleSourceSpan(visibleSourceSpan);
					const newStartTime = roundToFrame({ time: resizing.initialStartTime + (resizing.initialDuration - newDuration), rate: projectFps }) ?? resizing.initialStartTime + (resizing.initialDuration - newDuration);

						setCurrentTrimStart(newTrimStart);
						setCurrentStartTime(newStartTime);
						setCurrentDuration(newDuration);
						currentTrimStartRef.current = newTrimStart;
						currentStartTimeRef.current = newStartTime;
						currentDurationRef.current = newDuration;
					}
				}
			} else {
				const sourceDuration = getSourceDuration({
					trimStart: resizing.initialTrimStart,
					duration: resizing.initialDuration,
					trimEnd: resizing.initialTrimEnd,
				});
				const newTrimEnd =
					resizing.initialTrimEnd - getSourceDeltaForClipDelta(deltaTime);
				const maxAllowedDuration = Number.isFinite(rightNeighborBound)
					? rightNeighborBound - resizing.initialStartTime
					: Infinity;

				if (newTrimEnd < 0) {
					if (canExtendElementDuration()) {
						const extensionNeeded = Math.abs(newTrimEnd);
						const baseDuration =
							resizing.initialDuration + resizing.initialTrimEnd;
					const newDuration = roundToFrame({ time: Math.min(baseDuration + extensionNeeded, maxAllowedDuration), rate: projectFps }) ?? Math.min(baseDuration + extensionNeeded, maxAllowedDuration);

						setCurrentDuration(newDuration);
						setCurrentTrimEnd(0);
						currentDurationRef.current = newDuration;
						currentTrimEndRef.current = 0;
					} else {
						const unclampedDuration = getDurationForVisibleSourceSpan(
							Math.max(0, sourceDuration - resizing.initialTrimStart),
						);
					const newDuration = roundToFrame({ time: Math.min(unclampedDuration, maxAllowedDuration), rate: projectFps }) ?? Math.min(unclampedDuration, maxAllowedDuration);

						setCurrentDuration(newDuration);
						setCurrentTrimEnd(0);
						currentDurationRef.current = newDuration;
						currentTrimEndRef.current = 0;
					}
				} else {
					const minTrimEndForNeighbor = Number.isFinite(maxAllowedDuration)
						? Math.max(
								0,
								sourceDuration -
									resizing.initialTrimStart -
									getVisibleSourceSpanForDuration(maxAllowedDuration),
							)
						: 0;
					const maxTrimEnd =
						sourceDuration -
						resizing.initialTrimStart -
						getVisibleSourceSpanForDuration(minDuration);
					const clampedTrimEnd = Math.min(
						maxTrimEnd,
						Math.max(minTrimEndForNeighbor, newTrimEnd),
					);
				const finalTrimEnd = roundToFrame({ time: clampedTrimEnd, rate: projectFps }) ?? clampedTrimEnd;
					const visibleSourceSpan = Math.max(
						0,
						sourceDuration - resizing.initialTrimStart - finalTrimEnd,
					);
				const newDuration = roundToFrame({ time: getDurationForVisibleSourceSpan(visibleSourceSpan), rate: projectFps }) ?? getDurationForVisibleSourceSpan(visibleSourceSpan);

					setCurrentTrimEnd(finalTrimEnd);
					setCurrentDuration(newDuration);
					currentTrimEndRef.current = finalTrimEnd;
					currentDurationRef.current = newDuration;
				}
			}
		},
		[
			resizing,
			zoomLevel,
			snappingEnabled,
			rollEditingEnabled,
			editor,
			element.id,
			track.elements,
			onSnapPointChange,
			canExtendElementDuration,
			getDurationForVisibleSourceSpan,
			getSourceDeltaForClipDelta,
			getSourceDuration,
			getVisibleSourceSpanForDuration,
			isShiftHeldRef,
		],
	);

	/**
	 * Roll edit commit: the dragged edge moved the cut, so the abutting
	 * neighbor takes the complementary patch. Media-backed neighbors trade
	 * trim for the moved span (clamped to the material they actually have —
	 * running out leaves an honest gap instead of inventing frames).
	 */
	const applyRollToNeighbor = useCallback(
		({
			side,
			initial,
			finalStartTime,
			finalDuration,
		}: {
			side: "left" | "right";
			initial: ResizeState;
			finalStartTime: number;
			finalDuration: number;
		}) => {
			const initialEndTime = initial.initialStartTime + initial.initialDuration;
			const projectFps = editor.project.getActive().settings.fps;
			const minDuration = Math.round(
				(TICKS_PER_SECOND * projectFps.denominator) / projectFps.numerator,
			);

			if (side === "right") {
				const neighbor = track.elements.find(
					(el) =>
						el.id !== element.id &&
						Math.abs(el.startTime - initialEndTime) <= ROLL_ABUT_EPSILON,
				);
				if (!neighbor) return;
				let delta = finalStartTime + finalDuration - neighbor.startTime;
				if (delta === 0) return;
				// Pulling the cut left grows the neighbor's head — media clips
				// only have trimStart's worth of extra material.
				if (delta < 0 && neighbor.sourceDuration != null) {
					delta = Math.max(delta, -neighbor.trimStart);
				}
				const newDuration = neighbor.duration - delta;
				if (newDuration < minDuration) return;
				editor.timeline.updateElementTrim({
					elementId: neighbor.id,
					trimStart:
						neighbor.sourceDuration != null
							? Math.max(0, neighbor.trimStart + delta)
							: neighbor.trimStart,
					trimEnd: neighbor.trimEnd,
					startTime: neighbor.startTime + delta,
					duration: newDuration,
				});
				return;
			}

			const neighbor = track.elements.find(
				(el) =>
					el.id !== element.id &&
					Math.abs(el.startTime + el.duration - initial.initialStartTime) <=
						ROLL_ABUT_EPSILON,
			);
			if (!neighbor) return;
			let delta = finalStartTime - initial.initialStartTime;
			if (delta === 0) return;
			// Pushing the cut right grows the neighbor's tail — clamp to the
			// tail material a media clip actually has.
			if (delta > 0 && neighbor.sourceDuration != null) {
				delta = Math.min(delta, neighbor.trimEnd);
			}
			const newDuration = neighbor.duration + delta;
			if (newDuration < minDuration) return;
			editor.timeline.updateElementTrim({
				elementId: neighbor.id,
				trimStart: neighbor.trimStart,
				trimEnd:
					neighbor.sourceDuration != null
						? Math.max(0, neighbor.trimEnd - delta)
						: neighbor.trimEnd,
				duration: newDuration,
			});
		},
		[editor, element.id, track.elements],
	);

	const handleResizeEnd = useCallback(() => {
		if (!resizing) return;

		const finalTrimStart = currentTrimStartRef.current;
		const finalTrimEnd = currentTrimEndRef.current;
		const finalStartTime = currentStartTimeRef.current;
		const finalDuration = currentDurationRef.current;
		const trimStartChanged = finalTrimStart !== resizing.initialTrimStart;
		const trimEndChanged = finalTrimEnd !== resizing.initialTrimEnd;
		const startTimeChanged = finalStartTime !== resizing.initialStartTime;
		const durationChanged = finalDuration !== resizing.initialDuration;

		if (
			trimStartChanged ||
			trimEndChanged ||
			startTimeChanged ||
			durationChanged
		) {
			if (rollEditingEnabled) {
				// Neighbor first — its bounds math reads the dragged element's
				// pre-commit geometry.
				applyRollToNeighbor({
					side: resizing.side,
					initial: resizing,
					finalStartTime,
					finalDuration,
				});
			}
			editor.timeline.updateElementTrim({
				elementId: element.id,
				trimStart: finalTrimStart,
				trimEnd: finalTrimEnd,
				startTime: startTimeChanged ? finalStartTime : undefined,
				duration: durationChanged ? finalDuration : undefined,
			});
		}

		setResizing(null);
		onResizeStateChange?.({ isResizing: false });
		onSnapPointChange?.(null);
	}, [
		resizing,
		editor.timeline,
		element.id,
		rollEditingEnabled,
		applyRollToNeighbor,
		onResizeStateChange,
		onSnapPointChange,
	]);

	useEffect(() => {
		if (!resizing) return;

		const handleDocumentMouseMove = ({ clientX }: MouseEvent) => {
			updateTrimFromMouseMove({ clientX });
		};

		const handleDocumentMouseUp = () => {
			handleResizeEnd();
		};

		document.addEventListener("mousemove", handleDocumentMouseMove);
		document.addEventListener("mouseup", handleDocumentMouseUp);

		return () => {
			document.removeEventListener("mousemove", handleDocumentMouseMove);
			document.removeEventListener("mouseup", handleDocumentMouseUp);
		};
	}, [resizing, handleResizeEnd, updateTrimFromMouseMove]);

	return {
		resizing,
		isResizing: resizing !== null,
		handleResizeStart,
		currentTrimStart,
		currentTrimEnd,
		currentStartTime,
		currentDuration,
	};
}
