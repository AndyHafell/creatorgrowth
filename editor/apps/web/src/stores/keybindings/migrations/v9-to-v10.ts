import type { KeybindingConfig } from "@/lib/actions/keybinding";

interface V9State {
	keybindings: KeybindingConfig;
	isCustomized: boolean;
}

/**
 * Adds the playback speed cycle (D, 1x → 2x → 3x) to existing users. Skips
 * the slot if the user has already remapped it to something else.
 */
export function v9ToV10({ state }: { state: unknown }): unknown {
	const v9 = state as V9State;
	const keybindings = { ...v9.keybindings };

	if (!keybindings.d) {
		keybindings.d = "cycle-playback-speed";
	}

	return { ...v9, keybindings };
}
