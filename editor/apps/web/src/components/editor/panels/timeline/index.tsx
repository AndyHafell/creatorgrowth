"use client";

import { ScrollArea } from "@/components/ui/scroll-area";
import {
	Delete02Icon,
	MagicWand05Icon,
	MusicNote03Icon,
	TaskAdd02Icon,
	TextIcon,
	ViewIcon,
	ViewOffSlashIcon,
	VolumeHighIcon,
	VolumeOffIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon, type IconSvgElement } from "@hugeicons/react";
import { OcShapesIcon, OcVideoIcon } from "@/components/icons";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useTimelineZoom } from "@/hooks/timeline/use-timeline-zoom";
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ReactNode,
} from "react";
import type { ElementDragState, DropTarget } from "@/lib/timeline";
import { TimelineTrackContent } from "./timeline-track";
import { TimelinePlayhead } from "./timeline-playhead";
import { SelectionBox } from "@/lib/selection/selection-box";
import { useBoxSelect } from "@/lib/selection/hooks/use-box-select";
import { SnapIndicator } from "./snap-indicator";
import type { SnapPoint } from "@/lib/timeline/snap-utils";
import type { TimelineTrack } from "@/lib/timeline";
import {
	TIMELINE_SCROLLBAR_SIZE_PX,
	TIMELINE_CONTENT_TOP_PADDING_PX,
	TIMELINE_TRACK_GAP_PX,
	TIMELINE_TRACK_LABELS_COLUMN_WIDTH_PX,
	TIMELINE_TRACK_HEIGHTS_PX,
	KEYFRAME_LANE_HEIGHT_PX,
} from "./layout";
import { TRACK_HEIGHT_SCALE_MIN } from "@/stores/timeline-store";
import { useElementInteraction } from "@/hooks/timeline/element/use-element-interaction";
import {
	canTrackHaveAudio,
	canTrackBeHidden,
	getTimelineZoomMin,
	getTimelinePaddingPx,
} from "@/lib/timeline";
import { timelineTimeToPixels } from "@/lib/timeline/pixel-utils";
import {
	getTrackHeight,
	getCumulativeHeightBefore,
	getTotalTracksHeight,
} from "./track-layout";
import { SELECTED_TRACK_ROW_CLASS } from "./theme";
import {
	computeTrackExpansionHeight,
	getTrackExpandedRows,
	getExpansionHeight,
	getPropertyLabel,
	type ExpandedRow,
} from "./expanded-layout";
import {
	TIMELINE_HORIZONTAL_WHEEL_STEP_PX,
	TIMELINE_ZOOM_BUTTON_FACTOR,
} from "./interaction";
import { TIMELINE_ZOOM_MAX } from "@/lib/timeline/scale";
import { TimelineToolbar } from "./timeline-toolbar";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import { useTimelineSeek } from "@/hooks/timeline/use-timeline-seek";
import { useTimelineDragDrop } from "@/hooks/timeline/use-timeline-drag-drop";
import { TimelineRuler } from "./timeline-ruler";
import { TimelineBookmarksRow } from "./bookmarks";
import { useBookmarkDrag } from "@/hooks/timeline/use-bookmark-drag";
import { useEdgeAutoScroll } from "@/hooks/timeline/use-edge-auto-scroll";
import { useInitialScrollBottom } from "@/hooks/timeline/use-initial-scroll-bottom";
import { useTimelineStore } from "@/stores/timeline-store";
import { useEditor } from "@/hooks/use-editor";
import { useTimelinePlayhead } from "@/hooks/timeline/use-timeline-playhead";
import { DragLine } from "./drag-line";
import { invokeAction } from "@/lib/actions";
import { resolveTimelineElementIntersections } from "./selection-hit-testing";
import { cn } from "@/utils/ui";
import {
	RenameTrackCommand,
	ReorderOverlayTracksCommand,
} from "@/lib/commands/timeline";

const TRACK_DRAG_MIME = "application/x-creatorgrowth-track-id";

const TRACKS_CONTAINER_MAX_HEIGHT = 800;
const FALLBACK_CONTAINER_WIDTH = 1000;
const TRACKS_CONTAINER_HEIGHT = { min: 0, max: TRACKS_CONTAINER_MAX_HEIGHT };
const TRACK_ICONS: Record<TimelineTrack["type"], ReactNode> = {
	video: <OcVideoIcon className="text-muted-foreground size-4 shrink-0" />,
	text: (
		<HugeiconsIcon
			icon={TextIcon}
			className="text-muted-foreground size-4 shrink-0"
		/>
	),
	audio: (
		<HugeiconsIcon
			icon={MusicNote03Icon}
			className="text-muted-foreground size-4 shrink-0"
		/>
	),
	graphic: <OcShapesIcon className="text-muted-foreground size-4 shrink-0" />,
	effect: (
		<HugeiconsIcon
			icon={MagicWand05Icon}
			className="text-muted-foreground size-4 shrink-0"
		/>
	),
};

export function Timeline() {
	const snappingEnabled = useTimelineStore((s) => s.snappingEnabled);
	// Subscribe so height-dependent layout re-computes when the vertical-zoom
	// slider is dragged OR a per-track override changes. getTrackHeight reads
	// both internally; we just need to invalidate React renders here.
	const trackHeightScale = useTimelineStore((s) => s.trackHeightScale);
	const trackHeightOverrides = useTimelineStore((s) => s.trackHeightOverrides);
	void trackHeightScale;
	void trackHeightOverrides;
	const {
		selectedElements,
		clearElementSelection,
		setElementSelection,
		mergeElementsIntoSelection,
	} = useElementSelection();
	const editor = useEditor();
	const timeline = editor.timeline;
	const scene = useEditor((currentEditor) => currentEditor.scenes.getActiveSceneOrNull());
	const tracks = useMemo<TimelineTrack[]>(
		() =>
			scene
				? [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]
				: [],
		[scene],
	);
	const mainTrackId = scene?.tracks.main.id ?? null;
	const seek = (time: number) => editor.playback.seek({ time });

	const timelineRef = useRef<HTMLDivElement>(null);
	const timelineHeaderRef = useRef<HTMLDivElement>(null);
	const rulerRef = useRef<HTMLDivElement>(null);
	const rulerScrollRef = useRef<HTMLDivElement>(null);
	const tracksContainerRef = useRef<HTMLDivElement>(null);
	const tracksScrollRef = useRef<HTMLDivElement>(null);
	const trackLabelsRef = useRef<HTMLDivElement>(null);
	const playheadRef = useRef<HTMLDivElement>(null);
	const trackLabelsScrollRef = useRef<HTMLDivElement>(null);

	const [isResizing, setIsResizing] = useState(false);
	const [currentSnapPoint, setCurrentSnapPoint] = useState<SnapPoint | null>(
		null,
	);

	const handleSnapPointChange = useCallback((snapPoint: SnapPoint | null) => {
		setCurrentSnapPoint(snapPoint);
	}, []);
	const handleResizeStateChange = useCallback(
		({ isResizing: nextIsResizing }: { isResizing: boolean }) => {
			setIsResizing(nextIsResizing);
			if (!nextIsResizing) {
				setCurrentSnapPoint(null);
			}
		},
		[],
	);

	const timelineDuration = timeline.getTotalDuration() || 0;
	const minZoomLevel = getTimelineZoomMin({
		duration: timelineDuration,
		containerWidth: tracksContainerRef.current?.clientWidth,
	});

	const savedViewState = editor.project.getTimelineViewState();

	const { zoomLevel, setZoomLevel, handleWheel, saveScrollPosition } =
		useTimelineZoom({
			containerRef: timelineRef,
			minZoom: minZoomLevel,
			initialZoom: savedViewState?.zoomLevel,
			initialScrollLeft: savedViewState?.scrollLeft,
			initialPlayheadTime: savedViewState?.playheadTime,
			tracksScrollRef,
			rulerScrollRef,
		});

	const expandedElementIds = useTimelineStore((s) => s.expandedElementIds);

	const getTrackExpansionHeight = useCallback(
		(trackIndex: number) => {
			const track = tracks[trackIndex];
			if (!track) return 0;
			return computeTrackExpansionHeight({ track, expandedElementIds });
		},
		[tracks, expandedElementIds],
	);

	// Stable refs so the wheel listener never goes stale
	const setZoomLevelRef = useRef(setZoomLevel);
	useEffect(() => {
		setZoomLevelRef.current = setZoomLevel;
	}, [setZoomLevel]);

	const saveScrollPositionRef = useRef(saveScrollPosition);
	useEffect(() => {
		saveScrollPositionRef.current = saveScrollPosition;
	}, [saveScrollPosition]);

	const minZoomLevelRef = useRef(minZoomLevel);
	useEffect(() => {
		minZoomLevelRef.current = minZoomLevel;
	}, [minZoomLevel]);

	// Listen for keybinding-dispatched zoom events. Bigger step than the
	// toolbar +/- buttons so a single Z/X tap covers more ground. Steps are
	// rAF-coalesced (like the wheel path below): holding X/Z key-repeats
	// faster than the timeline can re-render, and each uncoalesced step was a
	// full re-render of every track element.
	useEffect(() => {
		const KEYBOARD_ZOOM_FACTOR = TIMELINE_ZOOM_BUTTON_FACTOR ** 2; // ~2.89x
		let pendingSteps = 0;
		let rafId: ReturnType<typeof requestAnimationFrame> | null = null;
		const applyPendingSteps = () => {
			rafId = null;
			const steps = pendingSteps;
			pendingSteps = 0;
			if (steps === 0) return;
			setZoomLevelRef.current((prev) =>
				Math.max(
					minZoomLevelRef.current,
					Math.min(TIMELINE_ZOOM_MAX, prev * KEYBOARD_ZOOM_FACTOR ** steps),
				),
			);
		};
		const handler = (event: Event) => {
			const detail = (event as CustomEvent<{ direction: "in" | "out" }>)
				.detail;
			if (!detail) return;
			pendingSteps += detail.direction === "in" ? 1 : -1;
			if (rafId === null) {
				rafId = requestAnimationFrame(applyPendingSteps);
			}
		};
		window.addEventListener("timeline-zoom-action", handler);
		return () => {
			window.removeEventListener("timeline-zoom-action", handler);
			if (rafId !== null) cancelAnimationFrame(rafId);
		};
	}, []);

	// Pushes tracks scroll position to the two overflow:hidden followers
	// (ruler and track labels). Called from the wheel handler (before paint,
	// zero lag) and from onScroll on the tracks area (covers scrollbar drag).
	const syncFollowers = useCallback(() => {
		const tracks = tracksScrollRef.current;
		if (!tracks) return;
		if (rulerScrollRef.current) {
			rulerScrollRef.current.scrollLeft = tracks.scrollLeft;
		}
		if (trackLabelsScrollRef.current) {
			trackLabelsScrollRef.current.scrollTop = tracks.scrollTop;
		}
	}, []);

	// Follow the playhead: when it leaves the visible window the view flips a
	// page so the playhead re-enters at 20% from the left. Playback only flips
	// forward (manual back-scrolls stay put); seeks (clicks, Q/W review jumps,
	// J/L) follow in both directions.
	useEffect(() => {
		const followPlayhead = ({
			time,
			bothEdges,
		}: {
			time: number;
			bothEdges: boolean;
		}) => {
			const tracks = tracksScrollRef.current;
			if (!tracks) return;
			if (editor.playback.getIsScrubbing()) return;
			const px = timelineTimeToPixels({ time, zoomLevel });
			const { scrollLeft, clientWidth } = tracks;
			if (clientWidth <= 0) return;
			const pastRight = px > scrollLeft + clientWidth - 8;
			const pastLeft = bothEdges && px < scrollLeft;
			if (!pastRight && !pastLeft) return;
			tracks.scrollLeft = Math.max(0, px - clientWidth * 0.2);
			syncFollowers();
		};
		const onUpdate = (e: Event) => {
			const detail = (e as CustomEvent<{ time: number }>).detail;
			if (detail) followPlayhead({ time: detail.time, bothEdges: false });
		};
		const onSeek = (e: Event) => {
			const detail = (e as CustomEvent<{ time: number }>).detail;
			if (detail) followPlayhead({ time: detail.time, bothEdges: true });
		};
		window.addEventListener("playback-update", onUpdate);
		window.addEventListener("playback-seek", onSeek);
		return () => {
			window.removeEventListener("playback-update", onUpdate);
			window.removeEventListener("playback-seek", onSeek);
		};
	}, [zoomLevel, editor, syncFollowers]);

	// Single non-passive capture listener owns all wheel input. Prevents any
	// native scroll or browser zoom from firing inside the timeline.
	useEffect(() => {
		const container = timelineRef.current;
		if (!container) return;

		let pendingZoomDelta = 0;
		let zoomRafId: ReturnType<typeof requestAnimationFrame> | null = null;

		const onWheel = (e: WheelEvent) => {
			const isZoom = e.ctrlKey || e.metaKey;

			if (isZoom) {
				e.preventDefault();
				const normalizedDelta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
				pendingZoomDelta += normalizedDelta;

				if (zoomRafId === null) {
					zoomRafId = requestAnimationFrame(() => {
						const frameRawDelta = pendingZoomDelta;
						const cappedDelta =
							Math.sign(frameRawDelta) * Math.min(Math.abs(frameRawDelta), 30);
						const zoomFactor = Math.exp(-cappedDelta / 300);
						setZoomLevelRef.current((prev) => prev * zoomFactor);
						pendingZoomDelta = 0;
						zoomRafId = null;
					});
				}
				return;
			}

			const tracks = tracksScrollRef.current;
			if (!tracks) return;

			const isHorizontal =
				e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);

			e.preventDefault();

			if (isHorizontal) {
				const raw =
					Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
				const clamped =
					Math.sign(raw) *
					Math.min(Math.abs(raw), TIMELINE_HORIZONTAL_WHEEL_STEP_PX);
				tracks.scrollLeft = Math.max(0, tracks.scrollLeft + clamped);
			} else {
				tracks.scrollTop = Math.max(0, tracks.scrollTop + e.deltaY);
			}

			syncFollowers();
			saveScrollPositionRef.current();
		};

		container.addEventListener("wheel", onWheel, {
			passive: false,
			capture: true,
		});
		return () => {
			container.removeEventListener("wheel", onWheel, { capture: true });
			if (zoomRafId !== null) cancelAnimationFrame(zoomRafId);
		};
	}, [syncFollowers]);

	useInitialScrollBottom({
		tracksScrollRef,
		trackLabelsScrollRef,
		onAfterScroll: () => saveScrollPositionRef.current(),
		isReady: tracks.length > 0,
	});

	const {
		dragState,
		dragDropTarget,
		handleElementMouseDown,
		handleElementClick,
		lastMouseXRef,
	} = useElementInteraction({
		zoomLevel,
		timelineRef,
		tracksContainerRef,
		tracksScrollRef,
		snappingEnabled,
		onSnapPointChange: handleSnapPointChange,
	});

	const {
		dragState: bookmarkDragState,
		handleBookmarkMouseDown,
		lastMouseXRef: bookmarkLastMouseXRef,
	} = useBookmarkDrag({
		zoomLevel,
		scrollRef: tracksScrollRef,
		snappingEnabled,
		onSnapPointChange: handleSnapPointChange,
	});

	const { handleRulerMouseDown: handlePlayheadRulerMouseDown } =
		useTimelinePlayhead({
			zoomLevel,
			rulerRef,
			rulerScrollRef,
			tracksScrollRef,
			playheadRef,
		});

	const { isDragOver, dropTarget, dragProps } = useTimelineDragDrop({
		containerRef: tracksContainerRef,
		tracksScrollRef,
		zoomLevel,
	});

	const {
		selectionBox,
		handleMouseDown: handleSelectionMouseDown,
		isSelecting,
		shouldIgnoreClick,
	} = useBoxSelect({
		containerRef: tracksContainerRef,
		selectedIds: selectedElements,
		anchorId: null,
		getIsAdditiveSelection: (event) =>
			event.shiftKey || event.ctrlKey || event.metaKey,
		resolveIntersections: ({ startPos, currentPos }) => {
			if (!tracksContainerRef.current) {
				return [];
			}

			return resolveTimelineElementIntersections({
				container: tracksContainerRef.current,
				scrollContainer: tracksScrollRef.current,
				tracks,
				zoomLevel,
				startPos,
				currentPos,
			});
		},
		onSelectionChange: ({ intersectedIds, isAdditive }) => {
			if (isAdditive) {
				mergeElementsIntoSelection({ elements: intersectedIds });
			} else {
				setElementSelection({ elements: intersectedIds });
			}
		},
	});

	const containerWidth =
		tracksContainerRef.current?.clientWidth || FALLBACK_CONTAINER_WIDTH;
	const contentWidth = timelineTimeToPixels({ time: timelineDuration, zoomLevel });
	const paddingPx = getTimelinePaddingPx({
		containerWidth,
		zoomLevel,
		minZoom: minZoomLevel,
	});
	const dynamicTimelineWidth = Math.max(
		contentWidth + paddingPx,
		containerWidth,
	);
	const tracksViewportWidth =
		tracksScrollRef.current?.clientWidth ??
		tracksContainerRef.current?.clientWidth ??
		containerWidth;
	const hasHorizontalScrollbar = dynamicTimelineWidth > tracksViewportWidth;

	useEdgeAutoScroll({
		isActive: bookmarkDragState.isDragging,
		getMouseClientX: () => bookmarkLastMouseXRef.current,
		rulerScrollRef,
		tracksScrollRef,
		contentWidth: dynamicTimelineWidth,
	});

	const showSnapIndicator =
		snappingEnabled &&
		currentSnapPoint !== null &&
		(dragState.isDragging || bookmarkDragState.isDragging || isResizing);

	const {
		handleTracksMouseDown,
		handleTracksClick,
		handleRulerMouseDown,
		handleRulerClick,
	} = useTimelineSeek({
		playheadRef,
		trackLabelsRef,
		rulerScrollRef,
		tracksScrollRef,
		zoomLevel,
		duration: timeline.getTotalDuration(),
		isSelecting,
		clearSelectedElements: clearElementSelection,
		seek,
	});

	const timelineHeaderHeight =
		(timelineHeaderRef.current?.getBoundingClientRect().height ?? 0) +
			TIMELINE_CONTENT_TOP_PADDING_PX || 0;

	return (
		<section
			className={
				"panel bg-background relative flex h-full flex-col overflow-hidden rounded-sm border"
			}
			{...dragProps}
			aria-label="Timeline"
		>
			<TimelineToolbar
				zoomLevel={zoomLevel}
				minZoom={minZoomLevel}
				setZoomLevel={({ zoom }) => setZoomLevel(zoom)}
			/>

			<div className="relative flex flex-1 overflow-hidden" ref={timelineRef}>
				<TrackLabelsPanel
					trackLabelsRef={trackLabelsRef}
					trackLabelsScrollRef={trackLabelsScrollRef}
					timelineHeaderHeight={timelineHeaderHeight}
					hasHorizontalScrollbar={hasHorizontalScrollbar}
					getTrackExpansionHeight={getTrackExpansionHeight}
				/>

				<div
					className="relative isolate flex flex-1 flex-col overflow-hidden"
					ref={tracksContainerRef}
				>
					<SelectionBox
						startPos={selectionBox?.startPos || null}
						currentPos={selectionBox?.currentPos || null}
						containerRef={tracksContainerRef}
						isActive={selectionBox?.isActive || false}
					/>
					<DragLine
						dropTarget={dropTarget}
						tracks={tracks}
						isVisible={isDragOver && !dropTarget?.targetElement}
						headerHeight={timelineHeaderHeight}
					/>
					<DragLine
						dropTarget={dragDropTarget}
						tracks={tracks}
						isVisible={dragState.isDragging}
						headerHeight={timelineHeaderHeight}
					/>

					<div ref={rulerScrollRef} className="shrink-0 overflow-hidden">
						<div
							ref={timelineHeaderRef}
							className="flex flex-col"
							style={{ width: `${dynamicTimelineWidth}px` }}
						>
							<TimelineRuler
								zoomLevel={zoomLevel}
								dynamicTimelineWidth={dynamicTimelineWidth}
								rulerRef={rulerRef}
								tracksScrollRef={rulerScrollRef}
								handleWheel={handleWheel}
								handleTimelineContentClick={handleRulerClick}
								handleRulerTrackingMouseDown={handleRulerMouseDown}
								handleRulerMouseDown={handlePlayheadRulerMouseDown}
							/>
							<TimelineBookmarksRow
								zoomLevel={zoomLevel}
								dynamicTimelineWidth={dynamicTimelineWidth}
								dragState={bookmarkDragState}
								onBookmarkMouseDown={handleBookmarkMouseDown}
								handleWheel={handleWheel}
								handleTimelineContentClick={handleRulerClick}
								handleRulerTrackingMouseDown={handleRulerMouseDown}
								handleRulerMouseDown={handlePlayheadRulerMouseDown}
							/>
						</div>
					</div>

					<ScrollArea
						className="flex-1"
						ref={tracksScrollRef}
						onScroll={() => {
							syncFollowers();
							saveScrollPosition();
						}}
					>
						<div
							className="flex min-h-full flex-col"
							style={{ width: `${dynamicTimelineWidth}px` }}
						>
							{/* biome-ignore lint/a11y/noStaticElementInteractions: canvas seek surface; keyboard seeking is handled by the global keybindings system */}
							{/* biome-ignore lint/a11y/useKeyWithClickEvents: canvas seek surface; keyboard seeking is handled by the global keybindings system */}
							<div
								className="relative shrink-0"
								style={{
									height: `${
										Math.max(
											TRACKS_CONTAINER_HEIGHT.min,
											Math.min(
												TRACKS_CONTAINER_HEIGHT.max,
												getTotalTracksHeight({ tracks, getExtraHeight: getTrackExpansionHeight }),
											),
										) + TIMELINE_CONTENT_TOP_PADDING_PX
									}px`,
								}}
								onMouseDown={(event) => {
									const isDirectTarget = event.target === event.currentTarget;
									if (!isDirectTarget) return;
									event.stopPropagation();
									handleTracksMouseDown(event);
									handleSelectionMouseDown(event);
								}}
								onClick={(event) => {
									const isDirectTarget = event.target === event.currentTarget;
									if (!isDirectTarget) return;
									event.stopPropagation();
									handleTracksClick(event);
								}}
							>
								{tracks.length > 0 && (
		<TimelineTrackRows
					mainTrackId={mainTrackId}
										zoomLevel={zoomLevel}
										dragState={dragState}
										tracksScrollRef={tracksScrollRef}
										lastMouseXRef={lastMouseXRef}
										onSnapPointChange={handleSnapPointChange}
										onResizeStateChange={handleResizeStateChange}
										onElementMouseDown={handleElementMouseDown}
										onElementClick={handleElementClick}
										onTrackMouseDown={(event) => {
											handleSelectionMouseDown(event);
											handleTracksMouseDown(event);
										}}
										onTrackMouseUp={handleTracksClick}
										shouldIgnoreClick={shouldIgnoreClick}
										isDragOver={isDragOver}
										dropTarget={dropTarget}
									/>
								)}
							</div>
							<TimelineGutter
								onMouseDown={(event) => {
									handleTracksMouseDown(event);
									handleSelectionMouseDown(event);
								}}
								onClick={handleTracksClick}
							/>
						</div>
					</ScrollArea>

					<TimelinePlayhead
						zoomLevel={zoomLevel}
						hasHorizontalScrollbar={hasHorizontalScrollbar}
						rulerRef={rulerRef}
						rulerScrollRef={rulerScrollRef}
						tracksScrollRef={tracksScrollRef}
						timelineRef={timelineRef}
						playheadRef={playheadRef}
						isSnappingToPlayhead={
							showSnapIndicator && currentSnapPoint?.type === "playhead"
						}
					/>
				</div>
				<SnapIndicator
					snapPoint={currentSnapPoint}
					zoomLevel={zoomLevel}
					timelineRef={timelineRef}
					tracksScrollRef={tracksScrollRef}
					isVisible={showSnapIndicator}
				/>
			</div>
		</section>
	);
}

function TrackLabelsPanel({
	trackLabelsRef,
	trackLabelsScrollRef,
	timelineHeaderHeight,
	hasHorizontalScrollbar,
	getTrackExpansionHeight,
}: {
	trackLabelsRef: React.RefObject<HTMLDivElement | null>;
	trackLabelsScrollRef: React.RefObject<HTMLDivElement | null>;
	timelineHeaderHeight: number;
	hasHorizontalScrollbar: boolean;
	getTrackExpansionHeight: (trackIndex: number) => number;
}) {
	const editor = useEditor();
	const scene = useEditor((e) => e.scenes.getActiveSceneOrNull());
	const tracks = useMemo<TimelineTrack[]>(
		() =>
			scene
				? [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]
				: [],
		[scene],
	);
	const { selectedElements } = useElementSelection();
	const tracksWithSelection = useMemo(
		() => new Set(selectedElements.map((el) => el.trackId)),
		[selectedElements],
	);

	const expandedElementIds = useTimelineStore((s) => s.expandedElementIds);
	const trackExpandedRowsMap = useMemo(
		() =>
			tracks.map((track) =>
				getTrackExpandedRows({ track, expandedElementIds }),
			),
		[tracks, expandedElementIds],
	);

	const overlayTrackIds = useMemo(
		() => (scene?.tracks.overlay ?? []).map((t) => t.id),
		[scene],
	);
	const overlayCount = overlayTrackIds.length;
	// Subscribe so re-renders fire when the user drags the vertical-zoom slider,
	// drags a per-track resize handle, or drags the column divider.
	// getTrackHeight reads scale + overrides via getState().
	const trackHeightScale = useTimelineStore((s) => s.trackHeightScale);
	const trackHeightOverrides = useTimelineStore((s) => s.trackHeightOverrides);
	const setTrackHeightOverride = useTimelineStore(
		(s) => s.setTrackHeightOverride,
	);
	const clearTrackHeightOverride = useTimelineStore(
		(s) => s.clearTrackHeightOverride,
	);
	const labelColumnWidth = useTimelineStore((s) => s.trackLabelColumnWidth);
	const setLabelColumnWidth = useTimelineStore(
		(s) => s.setTrackLabelColumnWidth,
	);
	void trackHeightScale;
	void trackHeightOverrides;
	const [draggingTrackId, setDraggingTrackId] = useState<string | null>(null);
	// dropPos: { rowIndex, position } — position is "before" or "after" the row.
	const [dropPos, setDropPos] = useState<{
		index: number;
		side: "before" | "after";
	} | null>(null);

	const handleTrackDragStart = useCallback(
		(event: React.DragEvent, trackId: string) => {
			event.dataTransfer.setData(TRACK_DRAG_MIME, trackId);
			event.dataTransfer.effectAllowed = "move";
			setDraggingTrackId(trackId);
		},
		[],
	);

	const handleTrackDragOver = useCallback(
		(event: React.DragEvent, rowIndex: number) => {
			if (draggingTrackId === null) return;
			if (rowIndex >= overlayCount) return; // only overlay rows accept reorder
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			const rect = event.currentTarget.getBoundingClientRect();
			const midpoint = rect.top + rect.height / 2;
			const side = event.clientY < midpoint ? "before" : "after";
			setDropPos((cur) =>
				cur && cur.index === rowIndex && cur.side === side
					? cur
					: { index: rowIndex, side },
			);
		},
		[draggingTrackId, overlayCount],
	);

	const handleTrackDragEnd = useCallback(() => {
		setDraggingTrackId(null);
		setDropPos(null);
	}, []);

	const handleTrackDrop = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			const sourceId =
				event.dataTransfer.getData(TRACK_DRAG_MIME) || draggingTrackId;
			const target = dropPos;
			setDraggingTrackId(null);
			setDropPos(null);
			if (!sourceId || !target) return;
			if (target.index >= overlayCount) return;

			const currentOrder = [...overlayTrackIds];
			const fromIndex = currentOrder.indexOf(sourceId);
			if (fromIndex === -1) return;
			let toIndex = target.side === "before" ? target.index : target.index + 1;
			// Pulling something out of the list before reinserting shifts indices.
			if (fromIndex < toIndex) toIndex -= 1;
			if (toIndex === fromIndex) return;
			currentOrder.splice(fromIndex, 1);
			currentOrder.splice(toIndex, 0, sourceId);
			editor.command.execute({
				command: new ReorderOverlayTracksCommand(currentOrder),
			});
		},
		[draggingTrackId, dropPos, overlayCount, overlayTrackIds, editor],
	);

	return (
		<div
			className="relative flex shrink-0 flex-col border-r"
			style={{ width: `${labelColumnWidth}px` }}
		>
			<div
				className="shrink-0"
				style={{ height: timelineHeaderHeight || 48 }}
			/>
			<div ref={trackLabelsRef} className="flex-1 overflow-hidden">
				<div ref={trackLabelsScrollRef} className="size-full overflow-hidden">
					{tracks.length > 0 && (
						<div
							className="flex flex-col"
							style={{ gap: `${TIMELINE_TRACK_GAP_PX}px` }}
						>
							{tracks.map((track, index) => {
								const expandedRows = trackExpandedRowsMap[index];
								const baseHeight = getTrackHeight({
									type: track.type,
									trackId: track.id,
								});
								const isOverlayRow = index < overlayCount;
								const showDropBefore =
									isOverlayRow &&
									dropPos?.index === index &&
									dropPos.side === "before";
								const showDropAfter =
									isOverlayRow &&
									dropPos?.index === index &&
									dropPos.side === "after";
								const isBeingDragged = draggingTrackId === track.id;

								const isMainTrack = scene?.tracks.main.id === track.id;
								return (
									<ContextMenu key={track.id}>
										<ContextMenuTrigger asChild>
									<div
										className={cn(
											"group relative flex flex-col",
											tracksWithSelection.has(track.id) &&
												SELECTED_TRACK_ROW_CLASS,
											isBeingDragged && "opacity-40",
											showDropBefore && "border-primary border-t-2",
											showDropAfter && "border-primary border-b-2",
										)}
										style={{
											height: `${baseHeight + getTrackExpansionHeight(index)}px`,
										}}
										onDragOver={
											isOverlayRow
												? (event) => handleTrackDragOver(event, index)
												: undefined
										}
										onDrop={isOverlayRow ? handleTrackDrop : undefined}
									>
										<div
											className="flex shrink-0 items-center gap-2 px-2"
											style={{ height: `${baseHeight}px` }}
										>
											{isOverlayRow ? (
												<div
													role="button"
													tabIndex={-1}
													aria-label="Drag to reorder track"
													draggable
													onDragStart={(event) =>
														handleTrackDragStart(event, track.id)
													}
													onDragEnd={handleTrackDragEnd}
													onMouseDown={(event) => event.stopPropagation()}
													className="text-muted-foreground/60 hover:text-foreground flex h-full shrink-0 cursor-grab items-center px-0.5 active:cursor-grabbing"
												>
													<GripIcon />
												</div>
											) : (
												<div className="w-3 shrink-0" />
											)}
											<EditableTrackName track={track} />
											{canTrackHaveAudio(track) && (
												<TrackToggleIcon
													isOff={track.muted}
													icons={{
														on: VolumeHighIcon,
														off: VolumeOffIcon,
													}}
													onClick={() =>
														editor.timeline.toggleTrackMute({
															trackId: track.id,
														})
													}
												/>
											)}
											{canTrackBeHidden(track) && (
												<TrackToggleIcon
													isOff={track.hidden}
													icons={{
														on: ViewIcon,
														off: ViewOffSlashIcon,
													}}
													onClick={() =>
														editor.timeline.toggleTrackVisibility({
															trackId: track.id,
														})
													}
												/>
											)}
											<TrackIcon track={track} />
										</div>
										{expandedRows.length > 0 && (
											<PropertyTree rows={expandedRows} />
										)}
										<TrackRowResizeHandle
											trackId={track.id}
											currentHeight={baseHeight}
											trackType={track.type}
											onResize={setTrackHeightOverride}
										/>
									</div>
									</ContextMenuTrigger>
									<ContextMenuContent className="w-44">
										<ContextMenuItem
											onClick={() =>
												editor.timeline.toggleTrackMute({ trackId: track.id })
											}
											disabled={!canTrackHaveAudio(track)}
										>
											{canTrackHaveAudio(track) && track.muted
												? "Unmute track"
												: "Mute track"}
										</ContextMenuItem>
										<ContextMenuItem
											onClick={() =>
												editor.timeline.toggleTrackVisibility({
													trackId: track.id,
												})
											}
											disabled={!canTrackBeHidden(track)}
										>
											{canTrackBeHidden(track) && track.hidden
												? "Show track"
												: "Hide track"}
										</ContextMenuItem>
										{trackHeightOverrides[track.id] !== undefined && (
											<ContextMenuItem
												onClick={() => clearTrackHeightOverride(track.id)}
											>
												Reset height
											</ContextMenuItem>
										)}
										{!isMainTrack && (
											<ContextMenuItem
												onClick={() =>
													editor.timeline.removeTrack({ trackId: track.id })
												}
												variant="destructive"
												icon={<HugeiconsIcon icon={Delete02Icon} />}
											>
												Delete track
											</ContextMenuItem>
										)}
									</ContextMenuContent>
								</ContextMenu>
								);
							})}
						</div>
					)}
				</div>
			</div>
			<div
				className="bg-background shrink-0"
				style={{
					height: hasHorizontalScrollbar ? TIMELINE_SCROLLBAR_SIZE_PX : 0,
				}}
			/>
			<ColumnResizeHandle
				value={labelColumnWidth}
				setValue={setLabelColumnWidth}
			/>
		</div>
	);
}

/**
 * Drag handle along the right edge of the track-labels column. Updates the
 * persisted width in real-time; mouseup commits naturally via state. Clamped
 * by setTrackLabelColumnWidth at the store level.
 */
/**
 * Drag the bottom edge of a single track row to override its height (DaVinci
 * Resolve style). Writes directly to timeline-store on each mousemove so the
 * visible row + content row update live.
 *
 * Minimum is type-aware (TRACK_HEIGHT_SCALE_MIN × type-default) so dragging a
 * single row can't shrink below what the global vertical-zoom slider can
 * already produce at its min.
 */
function TrackRowResizeHandle({
	trackId,
	currentHeight,
	trackType,
	onResize,
}: {
	trackId: string;
	currentHeight: number;
	trackType: TimelineTrack["type"];
	onResize: (trackId: string, height: number) => void;
}) {
	const draggingRef = useRef(false);
	const startYRef = useRef(0);
	const startHeightRef = useRef(0);

	const onMouseDown = (event: React.MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		draggingRef.current = true;
		startYRef.current = event.clientY;
		startHeightRef.current = currentHeight;

		const typeMin = Math.max(
			12,
			Math.round(TIMELINE_TRACK_HEIGHTS_PX[trackType] * TRACK_HEIGHT_SCALE_MIN),
		);

		const onMove = (e: MouseEvent) => {
			if (!draggingRef.current) return;
			const delta = e.clientY - startYRef.current;
			onResize(trackId, Math.max(typeMin, startHeightRef.current + delta));
		};
		const onUp = () => {
			draggingRef.current = false;
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			document.body.style.cursor = "";
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		document.body.style.cursor = "row-resize";
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drag handle is mouse-only by design
		<div
			onMouseDown={onMouseDown}
			className="hover:bg-primary/40 absolute right-0 bottom-0 left-0 h-1 cursor-row-resize bg-transparent transition-colors"
			style={{ zIndex: 5 }}
		/>
	);
}

function ColumnResizeHandle({
	value,
	setValue,
}: {
	value: number;
	setValue: (n: number) => void;
}) {
	const draggingRef = useRef(false);
	const startXRef = useRef(0);
	const startWidthRef = useRef(0);

	const onMouseDown = (event: React.MouseEvent) => {
		event.preventDefault();
		draggingRef.current = true;
		startXRef.current = event.clientX;
		startWidthRef.current = value;

		const onMove = (e: MouseEvent) => {
			if (!draggingRef.current) return;
			const delta = e.clientX - startXRef.current;
			setValue(startWidthRef.current + delta);
		};
		const onUp = () => {
			draggingRef.current = false;
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			document.body.style.cursor = "";
		};
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		document.body.style.cursor = "col-resize";
	};

	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: drag handle is mouse-only by design
		<div
			onMouseDown={onMouseDown}
			className="hover:bg-primary/40 absolute top-0 right-0 bottom-0 w-1 cursor-col-resize bg-transparent transition-colors"
			style={{ zIndex: 5 }}
		/>
	);
}

function TimelineTrackRows({
	mainTrackId,
	zoomLevel,
	dragState,
	tracksScrollRef,
	lastMouseXRef,
	onSnapPointChange,
	onResizeStateChange,
	onElementMouseDown,
	onElementClick,
	onTrackMouseDown,
	onTrackMouseUp,
	shouldIgnoreClick,
	isDragOver,
	dropTarget,
}: {
	mainTrackId: string | null;
	zoomLevel: number;
	dragState: ElementDragState;
	tracksScrollRef: React.RefObject<HTMLDivElement | null>;
	lastMouseXRef: React.RefObject<number>;
	onSnapPointChange: (snapPoint: SnapPoint | null) => void;
	onResizeStateChange: (params: { isResizing: boolean }) => void;
	onElementMouseDown: React.ComponentProps<
		typeof TimelineTrackContent
	>["onElementMouseDown"];
	onElementClick: React.ComponentProps<
		typeof TimelineTrackContent
	>["onElementClick"];
	onTrackMouseDown: (event: React.MouseEvent) => void;
	onTrackMouseUp: (event: React.MouseEvent) => void;
	shouldIgnoreClick: () => boolean;
	isDragOver: boolean;
	dropTarget: DropTarget | null;
}) {
	const timeline = useEditor((e) => e.timeline);
	const scene = useEditor((e) => e.scenes.getActiveSceneOrNull());
	const tracks = useMemo<TimelineTrack[]>(
		() =>
			scene
				? [...scene.tracks.overlay, scene.tracks.main, ...scene.tracks.audio]
				: [],
		[scene],
	);
	const { selectedElements } = useElementSelection();
	const tracksWithSelection = useMemo(
		() => new Set(selectedElements.map((el) => el.trackId)),
		[selectedElements],
	);

	const expandedElementIds = useTimelineStore((s) => s.expandedElementIds);

	const getTrackExpansionHeight = useCallback(
		(trackIndex: number) => {
			const track = tracks[trackIndex];
			if (!track) return 0;
			return computeTrackExpansionHeight({ track, expandedElementIds });
		},
		[tracks, expandedElementIds],
	);

	const sortedTracks = useMemo(() => {
		const draggingElementIds = new Set(dragState.dragElementIds);
		return [...tracks]
			.map((track, index) => ({ track, index }))
			.sort((a, b) => {
				const aHasDragged = a.track.elements.some((element) =>
					draggingElementIds.has(element.id),
				);
				const bHasDragged = b.track.elements.some((element) =>
					draggingElementIds.has(element.id),
				);
				if (aHasDragged) return 1;
				if (bHasDragged) return -1;
				return 0;
			});
	}, [tracks, dragState.dragElementIds]);

	return (
		<>
			{sortedTracks.map(({ track, index }) => (
				<ContextMenu key={track.id}>
					<ContextMenuTrigger asChild>
						<div
							className={cn(
								"absolute right-0 left-0 transition-colors",
								tracksWithSelection.has(track.id) &&
									SELECTED_TRACK_ROW_CLASS,
							)}
							style={{
								top: `${TIMELINE_CONTENT_TOP_PADDING_PX + getCumulativeHeightBefore({ tracks, trackIndex: index, getExtraHeight: getTrackExpansionHeight })}px`,
								height: `${getTrackHeight({ type: track.type, trackId: track.id }) + getTrackExpansionHeight(index)}px`,
							}}
						>
							<TimelineTrackContent
								track={track}
								zoomLevel={zoomLevel}
								dragState={dragState}
								rulerScrollRef={tracksScrollRef}
								tracksScrollRef={tracksScrollRef}
								lastMouseXRef={lastMouseXRef}
								onSnapPointChange={onSnapPointChange}
								onResizeStateChange={onResizeStateChange}
								onElementMouseDown={onElementMouseDown}
								onElementClick={onElementClick}
								onTrackMouseDown={onTrackMouseDown}
								onTrackMouseUp={onTrackMouseUp}
								shouldIgnoreClick={shouldIgnoreClick}
								targetElementId={
									isDragOver
										? (dropTarget?.targetElement?.elementId ?? null)
										: null
								}
							/>
						</div>
					</ContextMenuTrigger>
					<ContextMenuContent className="w-40">
						<ContextMenuItem
							icon={<HugeiconsIcon icon={TaskAdd02Icon} />}
							onClick={(event: React.MouseEvent) => {
								event.stopPropagation();
								invokeAction("paste-copied");
							}}
						>
							Paste elements
						</ContextMenuItem>
						<ContextMenuItem
							icon={<HugeiconsIcon icon={VolumeHighIcon} />}
							onClick={(event: React.MouseEvent) => {
								event.stopPropagation();
								timeline.toggleTrackMute({ trackId: track.id });
							}}
						>
							{canTrackHaveAudio(track) && track.muted
								? "Unmute track"
								: "Mute track"}
						</ContextMenuItem>
						<ContextMenuItem
							icon={<HugeiconsIcon icon={ViewIcon} />}
							onClick={(event: React.MouseEvent) => {
								event.stopPropagation();
								timeline.toggleTrackVisibility({ trackId: track.id });
							}}
						>
							{canTrackBeHidden(track) && track.hidden
								? "Show track"
								: "Hide track"}
						</ContextMenuItem>
						{track.id !== mainTrackId && (
							<ContextMenuItem
								icon={<HugeiconsIcon icon={Delete02Icon} />}
								onClick={(event: React.MouseEvent) => {
									event.stopPropagation();
									timeline.removeTrack({ trackId: track.id });
								}}
								variant="destructive"
							>
								Delete track
							</ContextMenuItem>
						)}
					</ContextMenuContent>
				</ContextMenu>
			))}
		</>
	);
}

function TimelineGutter({
	onMouseDown,
	onClick,
}: {
	onMouseDown: (event: React.MouseEvent) => void;
	onClick: (event: React.MouseEvent) => void;
}) {
	// biome-ignore lint/a11y/noStaticElementInteractions: canvas seek surface; keyboard seeking is handled by the global keybindings system
	// biome-ignore lint/a11y/useKeyWithClickEvents: canvas seek surface; keyboard seeking is handled by the global keybindings system
	return <div className="flex-1" onMouseDown={onMouseDown} onClick={onClick} />;
}

function TrackIcon({ track }: { track: TimelineTrack }) {
	return <>{TRACK_ICONS[track.type]}</>;
}

/** Six-dot grip glyph; meant to read as a drag handle on a single row. */
function GripIcon() {
	return (
		<svg
			viewBox="0 0 16 16"
			className="size-3.5"
			aria-hidden="true"
			fill="currentColor"
		>
			<circle cx="5" cy="3.5" r="1.2" />
			<circle cx="5" cy="8" r="1.2" />
			<circle cx="5" cy="12.5" r="1.2" />
			<circle cx="11" cy="3.5" r="1.2" />
			<circle cx="11" cy="8" r="1.2" />
			<circle cx="11" cy="12.5" r="1.2" />
		</svg>
	);
}

/**
 * Double-click to enter edit mode. Enter/blur saves via RenameTrackCommand;
 * Escape cancels. Single-click is a no-op so it doesn't fight the row's own
 * track-selection click handlers.
 */
function EditableTrackName({ track }: { track: TimelineTrack }) {
	const editor = useEditor();
	const [editing, setEditing] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const originalRef = useRef("");

	const startEditing = () => {
		if (editing) return;
		originalRef.current = track.name;
		setEditing(true);
		requestAnimationFrame(() => inputRef.current?.select());
	};

	const commit = () => {
		const newName = inputRef.current?.value.trim() ?? "";
		setEditing(false);
		if (!newName || newName === originalRef.current) {
			if (inputRef.current) inputRef.current.value = originalRef.current;
			return;
		}
		editor.command.execute({
			command: new RenameTrackCommand(track.id, newName),
		});
	};

	const cancel = () => {
		if (inputRef.current) inputRef.current.value = originalRef.current;
		setEditing(false);
		inputRef.current?.blur();
	};

	if (editing) {
		return (
			<input
				ref={inputRef}
				type="text"
				defaultValue={track.name}
				autoFocus
				onBlur={commit}
				onKeyDown={(event) => {
					if (event.key === "Enter") {
						event.preventDefault();
						inputRef.current?.blur();
					} else if (event.key === "Escape") {
						event.preventDefault();
						cancel();
					}
					event.stopPropagation();
				}}
				onClick={(event) => event.stopPropagation()}
				onMouseDown={(event) => event.stopPropagation()}
				className="ring-ring min-w-0 flex-1 truncate rounded-sm bg-transparent px-1 text-[11px] font-medium outline-none ring-1"
			/>
		);
	}
	return (
		<div
			role="button"
			tabIndex={0}
			onDoubleClick={(event) => {
				event.stopPropagation();
				startEditing();
			}}
			title={`${track.name} (double-click to rename)`}
			className="text-muted-foreground hover:text-foreground min-w-0 flex-1 cursor-text truncate text-[11px] font-medium"
		>
			{track.name}
		</div>
	);
}

function TrackToggleIcon({
	isOff,
	icons,
	onClick,
}: {
	isOff: boolean;
	icons: {
		on: IconSvgElement;
		off: IconSvgElement;
	};
	onClick: () => void;
}) {
	return (
		<>
			{isOff ? (
				<HugeiconsIcon
					icon={icons.off}
					className="text-destructive size-4 cursor-pointer"
					onClick={onClick}
				/>
			) : (
				<HugeiconsIcon
					icon={icons.on}
					className="text-muted-foreground size-4 cursor-pointer"
					onClick={onClick}
				/>
			)}
		</>
	);
}

function PropertyTree({ rows }: { rows: ExpandedRow[] }) {
	return (
		<div className="flex flex-col overflow-hidden">
			{rows.map((row, index) => (
				<div
					key={row.propertyPath}
					className={cn(
						"flex shrink-0 items-center px-3 bg-muted/50",
					)}
					style={{ height: `${KEYFRAME_LANE_HEIGHT_PX}px` }}
				>
					<span className="text-muted-foreground truncate text-xs leading-none">
						{getPropertyLabel(row.propertyPath)}
					</span>
				</div>
			))}
		</div>
	);
}
