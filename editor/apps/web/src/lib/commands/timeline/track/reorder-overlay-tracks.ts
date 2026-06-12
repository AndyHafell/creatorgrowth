import { Command, type CommandResult } from "@/lib/commands/base-command";
import { EditorCore } from "@/core";
import type { OverlayTrack, SceneTracks } from "@/lib/timeline";

/**
 * Reorder the overlay-track stack. Any track id passed in keeps its requested
 * slot; tracks not mentioned get appended in their original relative order
 * (defensive — callers should always pass the full set).
 */
export class ReorderOverlayTracksCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor(private orderedTrackIds: string[]) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const scene = editor.scenes.getActiveScene();
		this.savedState = scene.tracks;

		const byId = new Map(scene.tracks.overlay.map((t) => [t.id, t]));
		const seen = new Set<string>();
		const reordered: OverlayTrack[] = [];
		for (const id of this.orderedTrackIds) {
			const t = byId.get(id);
			if (t && !seen.has(id)) {
				reordered.push(t);
				seen.add(id);
			}
		}
		for (const t of scene.tracks.overlay) {
			if (!seen.has(t.id)) reordered.push(t);
		}

		editor.timeline.updateTracks({
			...scene.tracks,
			overlay: reordered,
		});
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}
