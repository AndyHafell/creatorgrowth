/**
 * Step 5 — "Send to Edit". Materialize the Raw Cut segment model onto the
 * editor's shared timeline, non-destructively.
 *
 * Model: the kept (green) segments become contiguous clips on TWO dedicated
 * tracks — a "Raw Cut" video track and a "Raw Cut Audio" audio track (the video
 * clips' source audio is disabled so it isn't doubled). Silences rippled out =
 * the tight cut. Each clip references the SAME source media with
 * `trimStart`/`trimEnd` pointing at its span, so the cut footage isn't deleted —
 * it lives in the trimmed-off regions of the neighbouring clips. In Edit mode
 * you drag a clip's edge back out to recover anything Raw Cut removed.
 *
 * The audio track is viable because `audio-waveform.tsx` now decodes each source
 * ONCE and shares the (downsampled) buffer across all clips — previously every
 * audio clip decoded the whole file, so hundreds of them OOM-crashed the tab.
 *
 * Both tracks are built fully-populated and applied in a SINGLE `updateTracks`
 * (one undoable command). A 2hr clip yields hundreds of keep segments; inserting
 * them one command at a time re-cloned the whole timeline per element (O(n²)) and
 * hung the tab — so we assemble the arrays first and commit once.
 *
 * Timebase: segments live in BUFFER seconds (the 8kHz analysis buffer drifts
 * shorter than the real media), so every boundary is scaled to media/timeline
 * seconds by `k = mediaDuration / bufferDuration` before being placed. Timeline
 * fields are in ticks (`TICKS_PER_SECOND`).
 *
 * Render rides the existing in-browser WebCodecs export — nothing new there.
 */

import { EditorCore } from "@/core";
import { Command } from "@/lib/commands/base-command";
import type { EditorCore as EditorCoreType } from "@/core";
import type { RawCutSegment } from "@/lib/raw-cut/segments";
import { buildEmptyTrack } from "@/lib/timeline/placement";
import { buildElementFromMedia } from "@/lib/timeline/element-utils";
import type {
	AudioElement,
	AudioTrack,
	SceneTracks,
	VideoElement,
	VideoTrack,
} from "@/lib/timeline/types";
import { TICKS_PER_SECOND } from "@/lib/wasm/ticks";
import { generateUUID } from "@/utils/id";

const RAW_CUT_TRACK_NAME = "Raw Cut";
const RAW_CUT_AUDIO_TRACK_NAME = "Raw Cut Audio";

export interface SendToTimelineResult {
	keptClips: number;
	keptSec: number;
}

/** Replace the whole scene's tracks in one shot (undoable). */
class ReplaceTracksCommand extends Command {
	private saved: SceneTracks | null = null;
	constructor(private readonly next: SceneTracks) {
		super();
	}
	execute() {
		const editor = EditorCore.getInstance();
		this.saved = editor.scenes.getActiveScene().tracks;
		editor.timeline.updateTracks(this.next);
		return undefined;
	}
	undo() {
		if (this.saved) EditorCore.getInstance().timeline.updateTracks(this.saved);
	}
}

export function sendRawCutToTimeline({
	editor,
	mediaId,
	mediaName,
	segments,
	bufferDuration,
	mediaDuration,
}: {
	editor: EditorCoreType;
	mediaId: string;
	mediaName: string;
	segments: RawCutSegment[];
	bufferDuration: number;
	mediaDuration: number;
}): SendToTimelineResult {
	const keeps = segments.filter(
		(s) => s.status === "keep" && s.endSec - s.startSec > 0.0001,
	);
	if (keeps.length === 0) return { keptClips: 0, keptSec: 0 };

	const k =
		bufferDuration > 0 && mediaDuration > 0
			? mediaDuration / bufferDuration
			: 1;
	const sourceTicks = Math.max(1, Math.round(mediaDuration * TICKS_PER_SECOND));

	const videoElements: VideoElement[] = [];
	const audioElements: AudioElement[] = [];
	let cursorTicks = 0;
	let keptSec = 0;
	for (const s of keeps) {
		const aMedia = s.startSec * k;
		const bMedia = s.endSec * k;
		const trimStart = Math.max(0, Math.round(aMedia * TICKS_PER_SECOND));
		const durTicks = Math.max(
			1,
			Math.round((bMedia - aMedia) * TICKS_PER_SECOND),
		);
		const trimEnd = Math.max(0, sourceTicks - trimStart - durTicks);

		// Video clip — source audio disabled; the sound lives on the audio track.
		videoElements.push({
			...buildElementFromMedia({
				mediaId,
				mediaType: "video",
				name: mediaName,
				duration: durTicks,
				startTime: cursorTicks,
			}),
			id: generateUUID(),
			trimStart,
			trimEnd,
			sourceDuration: sourceTicks,
			isSourceAudioEnabled: false,
		} as VideoElement);

		// Paired audio clip — same span, on the dedicated audio track.
		audioElements.push({
			...buildElementFromMedia({
				mediaId,
				mediaType: "audio",
				name: mediaName,
				duration: durTicks,
				startTime: cursorTicks,
			}),
			id: generateUUID(),
			trimStart,
			trimEnd,
			sourceDuration: sourceTicks,
		} as AudioElement);

		cursorTicks += durTicks;
		keptSec += bMedia - aMedia;
	}

	const videoTrack: VideoTrack = {
		...buildEmptyTrack({
			id: generateUUID(),
			type: "video",
			name: RAW_CUT_TRACK_NAME,
		}),
		elements: videoElements,
	};
	const audioTrack: AudioTrack = {
		...buildEmptyTrack({
			id: generateUUID(),
			type: "audio",
			name: RAW_CUT_AUDIO_TRACK_NAME,
		}),
		elements: audioElements,
	};

	// Drop any prior Raw Cut tracks (idempotent re-send), prepend the fresh ones.
	const current = editor.scenes.getActiveScene().tracks;
	const next: SceneTracks = {
		...current,
		overlay: [
			videoTrack,
			...current.overlay.filter(
				(t) => !(t.type === "video" && t.name === RAW_CUT_TRACK_NAME),
			),
		],
		audio: [
			audioTrack,
			...current.audio.filter((t) => t.name !== RAW_CUT_AUDIO_TRACK_NAME),
		],
	};

	editor.command.execute({ command: new ReplaceTracksCommand(next) });
	return { keptClips: keeps.length, keptSec };
}

/** Remove ONLY a stale "Raw Cut Audio" track (left over from the old two-track
 *  version — the current Send never makes one). Keeps the video cut. Returns
 *  false if there was none. Used as a one-time auto-cleanup on editor load so a
 *  saved project with the heavy audio track doesn't crash the timeline. */
export function removeRawCutAudioTrack(editor: EditorCoreType): boolean {
	const current = editor.scenes.getActiveScene().tracks;
	if (!current.audio.some((t) => t.name === RAW_CUT_AUDIO_TRACK_NAME)) {
		return false;
	}
	const next: SceneTracks = {
		...current,
		audio: current.audio.filter((t) => t.name !== RAW_CUT_AUDIO_TRACK_NAME),
	};
	editor.command.execute({ command: new ReplaceTracksCommand(next) });
	return true;
}

/** Remove the Raw Cut video + audio tracks from the timeline (undoable). Leaves
 *  the source media and the Raw Cut session untouched. Returns false if there
 *  was nothing to remove. */
export function removeRawCutFromTimeline(editor: EditorCoreType): boolean {
	const current = editor.scenes.getActiveScene().tracks;
	const hasVideo = current.overlay.some(
		(t) => t.type === "video" && t.name === RAW_CUT_TRACK_NAME,
	);
	const hasAudio = current.audio.some(
		(t) => t.name === RAW_CUT_AUDIO_TRACK_NAME,
	);
	if (!hasVideo && !hasAudio) return false;

	const next: SceneTracks = {
		...current,
		overlay: current.overlay.filter(
			(t) => !(t.type === "video" && t.name === RAW_CUT_TRACK_NAME),
		),
		audio: current.audio.filter((t) => t.name !== RAW_CUT_AUDIO_TRACK_NAME),
	};
	editor.command.execute({ command: new ReplaceTracksCommand(next) });
	return true;
}
