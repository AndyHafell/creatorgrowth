import { useEffect } from "react";
import { invokeAction } from "@/lib/actions";
import { useEditor } from "@/hooks/use-editor";
import { useEditorModeStore } from "@/stores/editor-mode-store";
import { useKeybindingsStore } from "@/stores/keybindings-store";
import { useMagicReviewStore } from "@/stores/magic-review-store";
import { isTypableDOMElement } from "@/utils/browser";

/**
 * a composable that hooks to the caller component's
 * lifecycle and hooks to the keyboard events to fire
 * the appropriate actions based on keybindings
 */
export function useKeybindingsListener() {
	const editor = useEditor();
	const {
		keybindings,
		getKeybindingString,
		overlayDepth,
		isLoadingProject,
		isRecording,
	} = useKeybindingsStore();

	useEffect(() => {
		const eventOptions: AddEventListenerOptions = { capture: true };
		const handleKeyDown = (ev: KeyboardEvent) => {
			const normalizedKey = (ev.key ?? "").toLowerCase();

			if (overlayDepth > 0 || isLoadingProject || isRecording) {
				return;
			}

			// Raw Cut and Final Pass each own their own keymap
			// (use-raw-cut-keybindings / use-final-pass-keybindings). Stand the
			// global Edit-mode dispatch down outside Edit so e.g. `s` doesn't split
			// hidden timeline elements and `space` doesn't toggle the unmounted
			// compositor while those surfaces own playback/zoom keys.
			if (useEditorModeStore.getState().mode !== "edit") {
				return;
			}

			// Magic Review (inside Edit mode) owns the QWEASDXC cluster plus
			// playback/step/undo keys via use-magic-review-keybindings — stand
			// down entirely so e.g. `q`/`w` don't also split and `x` doesn't zoom.
			if (useMagicReviewStore.getState().active) {
				return;
			}

			const binding = getKeybindingString(ev);
			const activeElement = document.activeElement;
			const isTextInput =
				activeElement instanceof HTMLElement &&
				isTypableDOMElement({ element: activeElement });
			const boundAction = binding ? keybindings[binding] : undefined;

			if (normalizedKey === "escape" && isTextInput) {
				activeElement.blur();
				return;
			}

			if (!binding) return;
			if (!boundAction) return;

			if (isTextInput) return;
			if (boundAction === "paste-copied") {
				if (!editor.clipboard.hasEntry()) return;
				ev.preventDefault();
				invokeAction("paste-copied", undefined, "keypress");
				return;
			}

			ev.preventDefault();

			switch (boundAction) {
				case "seek-forward":
					invokeAction("seek-forward", { seconds: 1 }, "keypress");
					break;
				case "seek-backward":
					invokeAction("seek-backward", { seconds: 1 }, "keypress");
					break;
				case "jump-forward":
					invokeAction("jump-forward", { seconds: 5 }, "keypress");
					break;
				case "jump-backward":
					invokeAction("jump-backward", { seconds: 5 }, "keypress");
					break;
				default:
					invokeAction(boundAction, undefined, "keypress");
			}
		};

		document.addEventListener("keydown", handleKeyDown, eventOptions);

		return () => {
			document.removeEventListener("keydown", handleKeyDown, eventOptions);
		};
	}, [
		keybindings,
		getKeybindingString,
		overlayDepth,
		isLoadingProject,
		isRecording,
		editor,
	]);
}
