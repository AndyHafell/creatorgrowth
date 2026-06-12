"use client";

import { useEffect, useRef } from "react";
import { useEditorModeStore } from "@/stores/editor-mode-store";
import { isTypableDOMElement } from "@/utils/browser";

/**
 * Raw Cut keymap. Distinct from the global Edit-mode keybindings
 * (`use-keybindings.ts`), which stands down while `mode === "raw-cut"` so the
 * two schemes never double-fire on shared keys (space / z / x / s …).
 *
 * Attached as a capture-phase document listener while the Raw Cut surface is
 * mounted. Handlers are passed via a ref so this hook re-binds rarely and
 * always calls the latest closures.
 *
 * Scheme (RAW_CUT_PREP.md §8 + §7 + Andy's Q/W/E toggles):
 *   Space play/pause   Z / X zoom out / in
 *   1/2/3 speed        L speed up        K pause
 *   ← / → ∓1 frame     J ∓1 frame back
 *   A / D  prev / next green clip · Shift+A/D ∓5s
 *   Q / W / E          toggle prev / current / next GREEN clip
 *   Shift+Q / Shift+E  toggle prev / next adjacent clip
 *   O  toggle current + advance      Shift+O  sweep cut forward
 *   H lock   M mark    S split        U unwind (3 greens back)
 *   ↑ / ↓  next / prev clip boundary
 *   Shift+→ / Shift+←  next / prev GREEN clip
 *   Y / N  accept / reject blue suggestion
 *   Cmd/Ctrl+Z undo    Cmd/Ctrl+S save cuts
 */
export interface RawCutKeyHandlers {
	playPause?: () => void;
	zoomIn?: () => void;
	zoomOut?: () => void;
	setSpeed?: (rate: number) => void;
	speedUp?: () => void;
	pause?: () => void;
	stepFrames?: (frames: number) => void;
	jumpSeconds?: (delta: number) => void;
	// cut-status toggles
	toggleCurrent?: () => void;
	togglePrev?: () => void;
	toggleNext?: () => void;
	togglePrevGreen?: () => void;
	toggleNextGreen?: () => void;
	cycleAndAdvance?: () => void;
	sweepForward?: () => void;
	toggleLock?: () => void;
	toggleMark?: () => void;
	split?: () => void;
	unwind?: () => void;
	// navigation
	nextGreen?: () => void;
	prevGreen?: () => void;
	nextBoundary?: () => void;
	prevBoundary?: () => void;
	// blue suggestions
	acceptBlue?: () => void;
	rejectBlue?: () => void;
	// history / persistence
	undo?: () => void;
	save?: () => void;
}

export function useRawCutKeybindings(handlers: RawCutKeyHandlers) {
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;

	useEffect(() => {
		const onKeyDown = (ev: KeyboardEvent) => {
			if (useEditorModeStore.getState().mode !== "raw-cut") return;

			const active = document.activeElement;
			if (
				active instanceof HTMLElement &&
				isTypableDOMElement({ element: active })
			) {
				return;
			}

			const h = handlersRef.current;
			const shift = ev.shiftKey;
			const key = (ev.key ?? "").toLowerCase();

			const run = (fn?: () => void) => {
				if (!fn) return;
				ev.preventDefault();
				ev.stopPropagation();
				fn();
			};

			// Cmd/Ctrl combos: only undo + save; leave the rest to the browser/OS.
			if (ev.metaKey || ev.ctrlKey) {
				if (key === "z" && !shift) run(h.undo);
				else if (key === "s") run(h.save);
				return;
			}
			if (ev.altKey) return;

			switch (key) {
				case " ":
				case "spacebar":
					run(h.playPause);
					break;
				case "x":
					run(h.zoomIn);
					break;
				case "z":
					run(h.zoomOut);
					break;
				case "1":
					run(() => h.setSpeed?.(1));
					break;
				case "2":
					run(() => h.setSpeed?.(2));
					break;
				case "3":
					run(() => h.setSpeed?.(3));
					break;
				case "l":
					run(h.speedUp);
					break;
				case "k":
					run(h.pause);
					break;
				case "j":
					run(() => h.stepFrames?.(shift ? -10 : -1));
					break;
				case "arrowright":
					run(shift ? h.nextGreen : () => h.stepFrames?.(1));
					break;
				case "arrowleft":
					run(shift ? h.prevGreen : () => h.stepFrames?.(-1));
					break;
				// A / D = prev / next green clip (start). Shift+A / Shift+D = jump
				// 5s back / forward (review then cut).
				case "d":
					run(shift ? () => h.jumpSeconds?.(5) : h.nextGreen);
					break;
				case "a":
					run(shift ? () => h.jumpSeconds?.(-5) : h.prevGreen);
					break;
				case "arrowup":
					run(h.nextBoundary);
					break;
				case "arrowdown":
					run(h.prevBoundary);
					break;
				case "q":
					run(shift ? h.togglePrev : h.togglePrevGreen);
					break;
				case "w":
					run(h.toggleCurrent);
					break;
				case "e":
					run(shift ? h.toggleNext : h.toggleNextGreen);
					break;
				case "o":
					run(shift ? h.sweepForward : h.cycleAndAdvance);
					break;
				case "h":
					run(h.toggleLock);
					break;
				case "m":
					run(h.toggleMark);
					break;
				case "s":
					run(h.split);
					break;
				case "u":
					run(h.unwind);
					break;
				case "y":
					run(h.acceptBlue);
					break;
				case "n":
					run(h.rejectBlue);
					break;
				default:
					break;
			}
		};

		document.addEventListener("keydown", onKeyDown, { capture: true });
		return () => {
			document.removeEventListener("keydown", onKeyDown, { capture: true });
		};
	}, []);
}
