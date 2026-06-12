import { Command, type CommandResult } from "@/lib/commands/base-command";
import type { SceneTracks } from "@/lib/timeline";
import { EditorCore } from "@/core";

export class RenameTrackCommand extends Command {
	private savedState: SceneTracks | null = null;

	constructor(
		private trackId: string,
		private name: string,
	) {
		super();
	}

	execute(): CommandResult | undefined {
		const editor = EditorCore.getInstance();
		const scene = editor.scenes.getActiveScene();
		this.savedState = scene.tracks;

		const renameIn = <T extends { id: string; name: string }>(arr: T[]): T[] =>
			arr.map((t) => (t.id === this.trackId ? { ...t, name: this.name } : t));

		const updated: SceneTracks = {
			...scene.tracks,
			overlay: renameIn(scene.tracks.overlay) as SceneTracks["overlay"],
			main:
				scene.tracks.main.id === this.trackId
					? { ...scene.tracks.main, name: this.name }
					: scene.tracks.main,
			audio: renameIn(scene.tracks.audio) as SceneTracks["audio"],
		};

		editor.timeline.updateTracks(updated);
		return undefined;
	}

	undo(): void {
		if (this.savedState) {
			EditorCore.getInstance().timeline.updateTracks(this.savedState);
		}
	}
}
