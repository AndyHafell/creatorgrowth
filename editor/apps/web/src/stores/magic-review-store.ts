import { create } from "zustand";

/**
 * Magic Review — keyboard-first human pass over the AI's effect-track clips
 * (Magic Zoom / Magic Highlighter), inside Edit mode. While active, the
 * dedicated review keymap (use-magic-review-keybindings) owns the QWEASDXC
 * cluster and the global Edit keymap stands down. Not persisted: a review
 * session is something you enter deliberately, not state to restore on reload.
 */
interface MagicReviewStore {
	active: boolean;
	setActive: (active: boolean) => void;
	toggle: () => void;
}

export const useMagicReviewStore = create<MagicReviewStore>()((set) => ({
	active: false,
	setActive: (active) => set({ active }),
	toggle: () => set((s) => ({ active: !s.active })),
}));
