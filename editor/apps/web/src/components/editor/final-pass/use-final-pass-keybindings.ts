"use client";

import { useEffect, useRef } from "react";
import { useEditorModeStore } from "@/stores/editor-mode-store";
import { isTypableDOMElement } from "@/utils/browser";

/**
 * Final Pass keymap — the SAME editing scheme as Raw Cut
 * (use-raw-cut-keybindings), so Andy can run the whole video marking keep/cut by
 * hand: Q/W/E toggle clips, O cut+advance, S split, A/D jump green-to-green, etc.
 * M drops a blue chapter pin; N drops a purple feedback note — both at the playhead.
 *
 * The global Edit keymap (use-keybindings) stands down whenever mode !== "edit",
 * so these never double-fire on shared keys (space / z / x / s).
 *
 *   Space play/pause      Z / X zoom out / in
 *   1/2/3 speed   L speed up   K pause
 *   ← / →  ∓1 frame   J ∓1 frame back (⇧ = ∓10)
 *   A / D  prev / next clip boundary (green OR red) · ⇧A/⇧D ∓5s
 *   Q / W / E  toggle prev / current / next KEEP clip (⇧Q/⇧E = adjacent)
 *   O  cut current + advance      ⇧O sweep cut forward
 *   H lock   M chapter (blue)   N feedback (purple)   S split   U unwind   ↑/↓ clip boundary
 *   C toggle skip-cuts preview
 *   Cmd/Ctrl+Z undo   ⇧Cmd/Ctrl+Z redo
 */
export interface FinalPassKeyHandlers {
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
	// M = drop a blue chapter pin at the playhead; N = drop a purple feedback note.
	addChapter?: () => void;
	addFeedback?: () => void;
	split?: () => void;
	unwind?: () => void;
	// navigation
	nextCut?: () => void;
	prevCut?: () => void;
	nextBoundary?: () => void;
	prevBoundary?: () => void;
	// history
	undo?: () => void;
	redo?: () => void;
	// C = toggle skip-cuts preview playback.
	toggleSkipCuts?: () => void;
}

export function useFinalPassKeybindings(handlers: FinalPassKeyHandlers) {
	const handlersRef = useRef(handlers);
	handlersRef.current = handlers;

	useEffect(() => {
		const onKeyDown = (ev: KeyboardEvent) => {
			if (useEditorModeStore.getState().mode !== "final-pass") return;

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

			// Cmd/Ctrl combos: undo / redo only; leave the rest to the browser/OS.
			if (ev.metaKey || ev.ctrlKey) {
				if (key === "z" && !shift) run(h.undo);
				else if (key === "z" && shift) run(h.redo);
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
					run(() => h.stepFrames?.(1));
					break;
				case "arrowleft":
					run(() => h.stepFrames?.(-1));
					break;
				case "d":
					// Next clip boundary — green OR red (just "next cut"), not only
					// red cuts. Step through every segment one press at a time.
					run(shift ? () => h.jumpSeconds?.(5) : h.nextBoundary);
					break;
				case "a":
					run(shift ? () => h.jumpSeconds?.(-5) : h.prevBoundary);
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
					run(h.addChapter);
					break;
				case "n":
					run(h.addFeedback);
					break;
				case "s":
					run(h.split);
					break;
				case "c":
					run(h.toggleSkipCuts);
					break;
				case "u":
					run(h.unwind);
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
