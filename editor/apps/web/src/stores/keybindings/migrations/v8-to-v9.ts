import type { KeybindingConfig } from "@/lib/actions/keybinding";

interface V8State {
	keybindings: KeybindingConfig;
	isCustomized: boolean;
}

/**
 * Adds the Magic Review toggle (R) to existing users. Skips the slot if the
 * user has already remapped it to something else.
 */
export function v8ToV9({ state }: { state: unknown }): unknown {
	const v8 = state as V8State;
	const keybindings = { ...v8.keybindings };

	if (!keybindings.r) {
		keybindings.r = "toggle-magic-review";
	}

	return { ...v8, keybindings };
}
