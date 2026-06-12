import type { TrackType } from "@/lib/timeline";
import { useTimelineStore } from "@/stores/timeline-store";
import {
	KEYFRAME_LANE_HEIGHT_PX,
	TIMELINE_TRACK_GAP_PX,
	TIMELINE_TRACK_HEIGHTS_PX,
} from "./layout";

// Resolution order: per-track override → type-default × global scale.
// Reading via getState() keeps the signature pure-looking; React callers must
// subscribe to `trackHeightScale` / `trackHeightOverrides` separately so the
// component re-renders when the user drags the slider or a row edge.
export function getTrackHeight({
	type,
	trackId,
}: {
	type: TrackType;
	trackId?: string;
}): number {
	const state = useTimelineStore.getState();
	if (trackId !== undefined) {
		const override = state.trackHeightOverrides[trackId];
		if (typeof override === "number") return override;
	}
	return Math.round(TIMELINE_TRACK_HEIGHTS_PX[type] * state.trackHeightScale);
}

export function getExpandedTrackHeight({
	type,
	trackId,
	expandedLaneCount,
}: {
	type: TrackType;
	trackId?: string;
	expandedLaneCount: number;
}): number {
	return (
		getTrackHeight({ type, trackId }) +
		expandedLaneCount * KEYFRAME_LANE_HEIGHT_PX
	);
}

type TrackForLayout = { id?: string; type: TrackType };

export function getCumulativeHeightBefore({
	tracks,
	trackIndex,
	getExtraHeight,
}: {
	tracks: TrackForLayout[];
	trackIndex: number;
	getExtraHeight?: (trackIndex: number) => number;
}): number {
	return tracks
		.slice(0, trackIndex)
		.reduce(
			(sum, track, i) =>
				sum +
				getTrackHeight({ type: track.type, trackId: track.id }) +
				(getExtraHeight?.(i) ?? 0) +
				TIMELINE_TRACK_GAP_PX,
			0,
		);
}

export function getTotalTracksHeight({
	tracks,
	getExtraHeight,
}: {
	tracks: TrackForLayout[];
	getExtraHeight?: (trackIndex: number) => number;
}): number {
	const tracksHeight = tracks.reduce(
		(sum, track, i) =>
			sum +
			getTrackHeight({ type: track.type, trackId: track.id }) +
			(getExtraHeight?.(i) ?? 0),
		0,
	);
	const gapsHeight = Math.max(0, tracks.length - 1) * TIMELINE_TRACK_GAP_PX;
	return tracksHeight + gapsHeight;
}
