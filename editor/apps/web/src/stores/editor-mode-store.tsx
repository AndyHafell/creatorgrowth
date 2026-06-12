import { create } from "zustand";
import { persist } from "zustand/middleware";

export type EditorMode = "edit" | "raw-cut" | "final-pass";

interface EditorModeStore {
	mode: EditorMode;
	rawCutMediaId: string | null;
	finalPassMediaId: string | null;
	setMode: (mode: EditorMode) => void;
	openInRawCut: (mediaId: string) => void;
	exitRawCut: () => void;
	clearRawCutMedia: () => void;
	openInFinalPass: (mediaId: string) => void;
	clearFinalPassMedia: () => void;
}

export const useEditorModeStore = create<EditorModeStore>()(
	persist(
		(set) => ({
			mode: "edit",
			rawCutMediaId: null,
			finalPassMediaId: null,
			setMode: (mode) => set({ mode }),
			openInRawCut: (mediaId) =>
				set({ mode: "raw-cut", rawCutMediaId: mediaId }),
			exitRawCut: () => set({ mode: "edit" }),
			clearRawCutMedia: () => set({ rawCutMediaId: null }),
			openInFinalPass: (mediaId) =>
				set({ mode: "final-pass", finalPassMediaId: mediaId }),
			clearFinalPassMedia: () => set({ finalPassMediaId: null }),
		}),
		{
			name: "editor-mode",
			partialize: (state) => ({
				mode: state.mode,
				rawCutMediaId: state.rawCutMediaId,
				finalPassMediaId: state.finalPassMediaId,
			}),
		},
	),
);
