"use client";

import { useEffect, useMemo } from "react";
import { HugeiconsIcon } from "@hugeicons/react";
import { Cancel01Icon, MagicWand05Icon } from "@hugeicons/core-free-icons";
import { invokeAction } from "@/lib/actions";
import { useActionHandler } from "@/hooks/actions/use-action-handler";
import { useEditor } from "@/hooks/use-editor";
import { useElementSelection } from "@/hooks/timeline/element/use-element-selection";
import { buildEffectElement } from "@/lib/timeline/element-utils";
import {
	clampNudge,
	clipIndexAtTime,
	collectEffectClips,
	magicParamsForKind,
	nextClipIndex,
	prevClipIndex,
	type ReviewClip,
} from "@/lib/timeline/effect-review";
import type { OverlayTrack } from "@/lib/timeline";
import { TICKS_PER_SECOND } from "@/lib/wasm";
import { useMagicReviewStore } from "@/stores/magic-review-store";
import { useMagicReviewKeybindings } from "./use-magic-review-keybindings";

const REPLAY_LEAD_IN_TICKS = Math.round(0.5 * TICKS_PER_SECOND);
const EMPTY_OVERLAY: OverlayTrack[] = [];

function formatTicks(ticks: number): string {
	const totalSeconds = ticks / TICKS_PER_SECOND;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds - minutes * 60;
	return `${minutes}:${seconds.toFixed(1).padStart(4, "0")}`;
}

/**
 * Magic Review — the floating review bar over the preview plus the QWEASDXC
 * keymap behind it. AI does the work (Magic Zoom / Magic Highlighter clips on
 * the effect tracks), Andy checks it: play the cut, fly clip-to-clip, nudge or
 * kill each one without touching the mouse except for region drags (Agent 8's
 * MagicRegionOverlay opens automatically for whichever clip is selected).
 */
export function MagicReviewHud() {
	const active = useMagicReviewStore((s) => s.active);
	const setActive = useMagicReviewStore((s) => s.setActive);
	const toggle = useMagicReviewStore((s) => s.toggle);
	const editor = useEditor();
	const overlay = useEditor(
		(e) => e.scenes.getActiveSceneOrNull()?.tracks.overlay ?? EMPTY_OVERLAY,
	);
	const { selectedElements, selectElement, clearElementSelection } =
		useElementSelection();

	const clips = useMemo(() => collectEffectClips({ overlay }), [overlay]);

	const selectedRef =
		selectedElements.length === 1 ? selectedElements[0] : null;
	const currentIndex = selectedRef
		? clips.findIndex(
				(clip) =>
					clip.trackId === selectedRef.trackId &&
					clip.elementId === selectedRef.elementId,
			)
		: -1;
	const currentClip = currentIndex >= 0 ? clips[currentIndex] : null;

	const focusClip = ({
		clip,
		seek = true,
	}: {
		clip: ReviewClip;
		seek?: boolean;
	}) => {
		selectElement({ trackId: clip.trackId, elementId: clip.elementId });
		if (seek) {
			editor.playback.seek({ time: clip.startTime });
		}
	};

	// S key and review entry share the same "focus the clip at the playhead,
	// or the nearest one" move. Entering never yanks the playhead when it's
	// already inside a clip.
	const grabAtPlayhead = () => {
		const time = editor.playback.getCurrentTime();
		const atIndex = clipIndexAtTime({ clips, time });
		if (atIndex >= 0) {
			focusClip({ clip: clips[atIndex], seek: false });
			return;
		}
		const nextIndex = nextClipIndex({ clips, time });
		const fallbackIndex =
			nextIndex >= 0 ? nextIndex : prevClipIndex({ clips, time });
		if (fallbackIndex >= 0) focusClip({ clip: clips[fallbackIndex] });
	};

	useActionHandler(
		"toggle-magic-review",
		() => {
			const entering = !useMagicReviewStore.getState().active;
			toggle();
			if (!entering) return;
			// Re-entering on a clip that's already selected means "advance" —
			// otherwise R lands you on the same element you just reviewed.
			const time = editor.playback.getCurrentTime();
			const atIndex = clipIndexAtTime({ clips, time });
			if (atIndex >= 0) {
				const at = clips[atIndex];
				const alreadySelected =
					selectedRef?.trackId === at.trackId &&
					selectedRef?.elementId === at.elementId;
				if (!alreadySelected) {
					focusClip({ clip: at, seek: false });
					return;
				}
			}
			const nextIndex = nextClipIndex({ clips, time });
			const fallbackIndex =
				nextIndex >= 0 ? nextIndex : prevClipIndex({ clips, time });
			if (fallbackIndex >= 0) focusClip({ clip: clips[fallbackIndex] });
		},
		undefined,
	);

	useMagicReviewKeybindings({
		prevClip: () => {
			const index = prevClipIndex({
				clips,
				time: editor.playback.getCurrentTime(),
			});
			if (index >= 0) focusClip({ clip: clips[index] });
		},
		nextClip: () => {
			const index = nextClipIndex({
				clips,
				time: editor.playback.getCurrentTime(),
			});
			if (index >= 0) focusClip({ clip: clips[index] });
		},
		replayClip: () => {
			if (editor.playback.getIsPlaying()) {
				editor.playback.pause();
				return;
			}
			const clip =
				currentClip ??
				clips[
					clipIndexAtTime({ clips, time: editor.playback.getCurrentTime() })
				];
			if (!clip) return;
			editor.playback.seek({
				time: Math.max(0, clip.startTime - REPLAY_LEAD_IN_TICKS),
			});
			editor.playback.play();
		},
		playPause: () => {
			editor.playback.toggle();
		},
		nudgeSeconds: (deltaSeconds) => {
			if (!currentClip) return;
			const delta = clampNudge({
				clip: currentClip,
				clips,
				delta: Math.round(deltaSeconds * TICKS_PER_SECOND),
			});
			if (delta === 0) return;
			editor.timeline.updateElements({
				updates: [
					{
						trackId: currentClip.trackId,
						elementId: currentClip.elementId,
						patch: { startTime: currentClip.startTime + delta },
					},
				],
			});
		},
		grabAtPlayhead,
		splitClip: () => {
			invokeAction("split", undefined, "keypress");
		},
		deleteClip: () => {
			if (!currentClip) return;
			const remaining = clips.filter(
				(clip) =>
					clip.trackId !== currentClip.trackId ||
					clip.elementId !== currentClip.elementId,
			);
			const next =
				remaining.find((clip) => clip.startTime >= currentClip.startTime) ??
				remaining[remaining.length - 1] ??
				null;
			editor.timeline.deleteElements({
				elements: [
					{
						trackId: currentClip.trackId,
						elementId: currentClip.elementId,
					},
				],
			});
			if (next) {
				focusClip({ clip: next });
			} else {
				clearElementSelection();
			}
		},
		duplicateClip: () => {
			if (!currentClip) return;
			const duplicated = editor.timeline.duplicateElements({
				elements: [
					{
						trackId: currentClip.trackId,
						elementId: currentClip.elementId,
					},
				],
			});
			if (duplicated[0]) {
				selectElement(duplicated[0]);
			}
		},
		setKind: (kind) => {
			if (!currentClip) return;
			const found = editor.timeline.getElementsWithTracks({
				elements: [
					{
						trackId: currentClip.trackId,
						elementId: currentClip.elementId,
					},
				],
			})[0];
			if (!found || found.element.type !== "effect") return;
			const converted = magicParamsForKind({
				fromEffectType: found.element.effectType,
				params: found.element.params as Record<string, number | string>,
				targetKind: kind,
			});
			if (converted.effectType === found.element.effectType) return;
			// Fresh defaults for the target kind, then the carried-over camera
			// params — leftover params from the old kind don't leak through.
			const defaults = buildEffectElement({
				effectType: converted.effectType,
				startTime: 0,
				duration: 1,
			}).params;
			editor.timeline.updateElements({
				updates: [
					{
						trackId: currentClip.trackId,
						elementId: currentClip.elementId,
						patch: {
							effectType: converted.effectType,
							params: { ...defaults, ...converted.params },
						},
					},
				],
			});
		},
		stepFrames: (frames) => {
			const fps = editor.project.getActive().settings.fps;
			const ticksPerFrame = Math.round(
				(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
			);
			editor.playback.seek({
				time: editor.playback.getCurrentTime() + frames * ticksPerFrame,
			});
		},
		jumpSeconds: (deltaSeconds) => {
			editor.playback.seek({
				time:
					editor.playback.getCurrentTime() +
					Math.round(deltaSeconds * TICKS_PER_SECOND),
			});
		},
		zoomIn: () => {
			invokeAction("timeline-zoom-in", undefined, "keypress");
		},
		zoomOut: () => {
			invokeAction("timeline-zoom-out", undefined, "keypress");
		},
		exit: () => {
			setActive(false);
		},
		undo: () => {
			editor.command.undo();
		},
		redo: () => {
			editor.command.redo();
		},
	});

	// While review plays, selection rides the playhead: each Magic clip the
	// playhead enters becomes the selected one, so its box/overlay and the
	// properties panel update live in front of you.
	useEffect(() => {
		if (!active) return;
		const onUpdate = (event: Event) => {
			const detail = (event as CustomEvent<{ time: number }>).detail;
			if (!detail) return;
			const index = clipIndexAtTime({ clips, time: detail.time });
			if (index < 0) return;
			const clip = clips[index];
			if (
				selectedRef?.trackId === clip.trackId &&
				selectedRef?.elementId === clip.elementId
			) {
				return;
			}
			selectElement({ trackId: clip.trackId, elementId: clip.elementId });
		};
		window.addEventListener("playback-update", onUpdate);
		return () => {
			window.removeEventListener("playback-update", onUpdate);
		};
	}, [active, clips, selectedRef, selectElement]);

	if (!active) return null;

	// Flow-positioned between the preview viewport and its toolbar — never
	// covers the picture (Andy: the floating box sat on top of the video).
	return (
		<div className="flex shrink-0 justify-center px-2 pt-2">
			<div className="flex items-center gap-3 rounded-md border border-amber-400/40 bg-black/80 px-3 py-1.5 text-xs text-white shadow-lg backdrop-blur-sm">
				<span className="flex items-center gap-1.5 font-medium text-amber-400">
					<HugeiconsIcon icon={MagicWand05Icon} className="size-3.5" />
					Magic Review
				</span>
				{clips.length === 0 ? (
					<span className="text-muted-foreground">no effect clips</span>
				) : (
					<>
						<span className="tabular-nums">
							{currentIndex >= 0 ? currentIndex + 1 : "–"} / {clips.length}
						</span>
						{currentClip && (
							<span className="max-w-44 truncate text-muted-foreground">
								{currentClip.name} @ {formatTicks(currentClip.startTime)}
							</span>
						)}
					</>
				)}
				<span className="hidden whitespace-nowrap text-[10px] text-muted-foreground lg:inline">
					Q/W clips · E replay · A/D nudge · 1/2/3 kind · S split · G grab ·
					B delete · C dup · R exit
				</span>
				<button
					type="button"
					aria-label="Exit Magic Review"
					className="text-muted-foreground hover:text-white"
					onClick={() => setActive(false)}
				>
					<HugeiconsIcon icon={Cancel01Icon} className="size-3.5" />
				</button>
			</div>
		</div>
	);
}
