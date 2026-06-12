/**
 * UI state for the timeline
 * For core logic, use EditorCore instead.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export const TRACK_HEIGHT_SCALE_MIN = 0.3;
export const TRACK_HEIGHT_SCALE_MAX = 2.5;
export const TRACK_LABEL_WIDTH_MIN = 100;
export const TRACK_LABEL_WIDTH_MAX = 400;
// Hard floor — the caller (TrackRowResizeHandle) computes a type-aware floor
// (TRACK_HEIGHT_SCALE_MIN × type-default) so each track's minimum matches what
// the global slider can already produce. This floor catches anything below.
export const TRACK_HEIGHT_OVERRIDE_MIN = 12;
export const TRACK_HEIGHT_OVERRIDE_MAX = 400;

interface TimelineStore {
	snappingEnabled: boolean;
	toggleSnapping: () => void;
	rippleEditingEnabled: boolean;
	toggleRippleEditing: () => void;
	/** Roll edit: dragging a cut between two abutting clips moves both. */
	rollEditingEnabled: boolean;
	toggleRollEditing: () => void;
	expandedElementIds: Set<string>;
	toggleElementExpanded: (elementId: string) => void;
	trackHeightScale: number;
	setTrackHeightScale: (scale: number) => void;
	trackLabelColumnWidth: number;
	setTrackLabelColumnWidth: (width: number) => void;
	// Per-track absolute height overrides keyed by trackId. When set, this
	// value is used as-is and the global scale is ignored for that track —
	// matches DaVinci's "drag a track's bottom edge to size it independently."
	trackHeightOverrides: Record<string, number>;
	setTrackHeightOverride: (trackId: string, height: number) => void;
	clearTrackHeightOverride: (trackId: string) => void;
}

export const useTimelineStore = create<TimelineStore>()(
	persist(
		(set) => ({
			snappingEnabled: true,

			toggleSnapping: () => {
				set((state) => ({ snappingEnabled: !state.snappingEnabled }));
			},

			rippleEditingEnabled: false,

			toggleRippleEditing: () => {
				set((state) => ({
					rippleEditingEnabled: !state.rippleEditingEnabled,
				}));
			},

			rollEditingEnabled: false,

			toggleRollEditing: () => {
				set((state) => ({
					rollEditingEnabled: !state.rollEditingEnabled,
				}));
			},

			expandedElementIds: new Set<string>(),

			toggleElementExpanded: (elementId) => {
				set((state) => {
					const next = new Set(state.expandedElementIds);
					if (next.has(elementId)) {
						next.delete(elementId);
					} else {
						next.add(elementId);
					}
					return { expandedElementIds: next };
				});
			},

			trackHeightScale: 1,
			setTrackHeightScale: (scale) => {
				const clamped = Math.min(
					TRACK_HEIGHT_SCALE_MAX,
					Math.max(TRACK_HEIGHT_SCALE_MIN, scale),
				);
				set({ trackHeightScale: clamped });
			},

			trackLabelColumnWidth: 180,
			setTrackLabelColumnWidth: (width) => {
				const clamped = Math.min(
					TRACK_LABEL_WIDTH_MAX,
					Math.max(TRACK_LABEL_WIDTH_MIN, width),
				);
				set({ trackLabelColumnWidth: clamped });
			},

			trackHeightOverrides: {},
			setTrackHeightOverride: (trackId, height) => {
				const clamped = Math.min(
					TRACK_HEIGHT_OVERRIDE_MAX,
					Math.max(TRACK_HEIGHT_OVERRIDE_MIN, Math.round(height)),
				);
				set((state) => ({
					trackHeightOverrides: {
						...state.trackHeightOverrides,
						[trackId]: clamped,
					},
				}));
			},
			clearTrackHeightOverride: (trackId) => {
				set((state) => {
					if (!(trackId in state.trackHeightOverrides)) return state;
					const next = { ...state.trackHeightOverrides };
					delete next[trackId];
					return { trackHeightOverrides: next };
				});
			},
		}),
		{
			name: "timeline-store",
			partialize: (state) => ({
				snappingEnabled: state.snappingEnabled,
				rippleEditingEnabled: state.rippleEditingEnabled,
				rollEditingEnabled: state.rollEditingEnabled,
				trackHeightScale: state.trackHeightScale,
				trackLabelColumnWidth: state.trackLabelColumnWidth,
				trackHeightOverrides: state.trackHeightOverrides,
			}),
		},
	),
);
