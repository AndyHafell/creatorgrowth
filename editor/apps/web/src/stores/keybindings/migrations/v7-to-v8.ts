import type { KeybindingConfig } from "@/lib/actions/keybinding";

interface V7State {
	keybindings: KeybindingConfig;
	isCustomized: boolean;
}

/**
 * Adds the timeline zoom shortcuts (X = zoom in, Z = zoom out) to existing
 * users. Skips a slot if the user has already remapped it to something else.
 */
export function v7ToV8({ state }: { state: unknown }): unknown {
	const v7 = state as V7State;
	const keybindings = { ...v7.keybindings };

	if (!keybindings["x"]) {
		keybindings["x"] = "timeline-zoom-in";
	}
	if (!keybindings["z"]) {
		keybindings["z"] = "timeline-zoom-out";
	}

	return { ...v7, keybindings };
}
