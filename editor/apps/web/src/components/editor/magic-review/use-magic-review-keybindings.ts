"use client";

import { useEffect, useRef } from "react";
import { useEditorModeStore } from "@/stores/editor-mode-store";
import { useKeybindingsStore } from "@/stores/keybindings-store";
import { useMagicReviewStore } from "@/stores/magic-review-store";
import { isTypableDOMElement } from "@/utils/browser";

/**
 * Magic Review keymap — the QWEASDXC cluster for flying through the AI's
 * effect-track clips (Magic Zoom / Magic Highlighter) without touching the
 * mouse. Active only while Magic Review is on inside Edit mode; the global
 * Edit keymap (use-keybindings) stands down for the duration, so this hook
 * owns playback/step/undo keys too.
 *
 *   Q / W  jump to prev / next effect clip (seek + select, overlay opens)
 *   E      replay the current clip from just before its start; pause if playing
 *   Space  play/pause
 *   A / D  nudge current clip ∓0.1s (⇧ = ∓1s), clamped against neighbors
 *   S      split the current clip at the playhead (same muscle memory as Edit)
 *   G      grab the clip at the playhead
 *   B      delete current clip + advance (Delete/Backspace too)
 *   C      duplicate current clip
 *   1/2/3  convert current clip kind: reframe / zoom / highlight
 *   X / Z  timeline zoom in / out — same as Edit mode, NEVER delete (Andy's
 *          muscle memory; the global keymap is standing down so forward them)
 *   ← / →  ∓1 frame   ⇧←/⇧→ ∓5s
 *   Cmd/Ctrl+Z undo   ⇧Cmd/Ctrl+Z redo
 *   R / Escape  exit review
 */
export interface MagicReviewKeyHandlers {
	prevClip?: () => void;
	nextClip?: () => void;
	replayClip?: () => void;
	playPause?: () => void;
	nudgeSeconds?: (deltaSeconds: number) => void;
	grabAtPlayhead?: () => void;
	splitClip?: () => void;
	deleteClip?: () => void;
	duplicateClip?: () => void;
	setKind?: (kind: "reframe" | "zoom" | "highlight") => void;
	zoomIn?: () => void;
	zoomOut?: () => void;
	stepFrames?: (frames: number) => void;
	jumpSeconds?: (deltaSeconds: number) => void;
	exit?: () => void;
	undo?: () => void;
	redo?: () => void;
}

const FINE_NUDGE_SECONDS = 0.1;
const COARSE_NUDGE_SECONDS = 1;

export function useMagicReviewKeybindings(handlers: MagicReviewKeyHandlers) {
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;

	useEffect(() => {
		// Both this listener and the global keymap are capture listeners on
		// document, firing in registration order for the SAME keydown. The R
		// that ENTERS review (handled by the global keymap) must not also be
		// seen here as "exit" — that toggles review off in the same keypress
		// and the HUD never appears. The flag lags the store by a macrotask
		// (microtasks run BETWEEN listeners of one event), so within the
		// activating keydown it still reads the pre-event state.
		let activeBeforeEvent = useMagicReviewStore.getState().active;
		const unsubscribe = useMagicReviewStore.subscribe((s) => {
			const next = s.active;
			window.setTimeout(() => {
				activeBeforeEvent = next;
			}, 0);
		});

		const onKeyDown = (ev: KeyboardEvent) => {
			if (!useMagicReviewStore.getState().active) return;
			if (!activeBeforeEvent) return;
			if (useEditorModeStore.getState().mode !== "edit") return;
			const { overlayDepth, isRecording, isLoadingProject } =
				useKeybindingsStore.getState();
			if (overlayDepth > 0 || isRecording || isLoadingProject) return;

			const key = (ev.key ?? "").toLowerCase();
			const active = document.activeElement;
			if (
				active instanceof HTMLElement &&
				isTypableDOMElement({ element: active })
			) {
				// The global keymap's escape-blur stands down with the rest of it,
				// so replicate it here.
				if (key === "escape") active.blur();
				return;
			}

			const h = handlersRef.current;
			const shift = ev.shiftKey;

			const run = (fn?: () => void) => {
				if (!fn) return;
				ev.preventDefault();
				// Immediate: the global keymap listens on the same node — the R
				// that EXITS review must not reach it and re-toggle review on.
				ev.stopImmediatePropagation();
				fn();
			};

			if (ev.metaKey || ev.ctrlKey) {
				if (key === "z" && !shift) run(h.undo);
				else if (key === "z" && shift) run(h.redo);
				return;
			}
			if (ev.altKey) return;

			const nudgeStep = shift ? COARSE_NUDGE_SECONDS : FINE_NUDGE_SECONDS;

			switch (key) {
				case " ":
				case "spacebar":
					run(h.playPause);
					break;
				case "q":
					run(h.prevClip);
					break;
				case "w":
					run(h.nextClip);
					break;
				case "e":
					run(h.replayClip);
					break;
				case "a":
					run(() => h.nudgeSeconds?.(-nudgeStep));
					break;
				case "d":
					run(() => h.nudgeSeconds?.(nudgeStep));
					break;
				case "s":
					run(h.splitClip);
					break;
				case "g":
					run(h.grabAtPlayhead);
					break;
				case "b":
				case "delete":
				case "backspace":
					run(h.deleteClip);
					break;
				case "c":
					run(h.duplicateClip);
					break;
				case "1":
					run(() => h.setKind?.("reframe"));
					break;
				case "2":
					run(() => h.setKind?.("zoom"));
					break;
				case "3":
					run(() => h.setKind?.("highlight"));
					break;
				case "x":
					run(h.zoomIn);
					break;
				case "z":
					run(h.zoomOut);
					break;
				case "arrowright":
					run(shift ? () => h.jumpSeconds?.(5) : () => h.stepFrames?.(1));
					break;
				case "arrowleft":
					run(shift ? () => h.jumpSeconds?.(-5) : () => h.stepFrames?.(-1));
					break;
				case "r":
				case "escape":
					run(h.exit);
					break;
				default:
					break;
			}
		};

		document.addEventListener("keydown", onKeyDown, { capture: true });
		return () => {
			unsubscribe();
			document.removeEventListener("keydown", onKeyDown, { capture: true });
		};
	}, []);
}
