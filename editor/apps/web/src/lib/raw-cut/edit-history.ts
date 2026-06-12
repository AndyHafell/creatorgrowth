/**
 * Pure undo/redo stack transitions for the Raw Cut / Final Pass segment model.
 *
 * Each "state" on a stack is a full `RawCutSegment[]` snapshot. The hook
 * (`useRawCutSegments`) holds these stacks in refs and reassigns them with the
 * results of these functions, so the transition logic stays unit-testable and the
 * hook stays thin. All functions return NEW arrays (no mutation of inputs).
 *
 * Raw Cut only ever undoes; Final Pass adds redo (Shift+Cmd+Z). The redo stack is
 * cleared whenever a new edit is recorded (a new edit forks a fresh branch).
 */

import type { RawCutSegment } from "./segments";

export interface EditStacks {
	history: RawCutSegment[][];
	redo: RawCutSegment[][];
}

/**
 * Record an edit: push `prev` onto history and clear redo (a new edit starts a new
 * branch, so the old redo future is gone). `cap` bounds the history, dropping the
 * oldest entry when exceeded; omit it for an unbounded stack (raw-cut toggleIndex
 * recorded without a cap before, so it passes none to stay byte-identical).
 */
export function recordEdit(
	stacks: EditStacks,
	prev: RawCutSegment[],
	opts?: { cap?: number },
): EditStacks {
	let history = [...stacks.history, prev];
	const cap = opts?.cap;
	if (cap != null && history.length > cap) {
		history = history.slice(history.length - cap);
	}
	return { history, redo: [] };
}

/**
 * Undo: restore the most recent history state, pushing `current` onto redo so it
 * can be re-applied. Returns null when there's nothing to undo (caller keeps
 * `current`).
 */
export function undoEdit(
	stacks: EditStacks,
	current: RawCutSegment[],
): { segments: RawCutSegment[]; stacks: EditStacks } | null {
	if (stacks.history.length === 0) return null;
	const history = stacks.history.slice(0, -1);
	const segments = stacks.history[stacks.history.length - 1];
	return {
		segments,
		stacks: { history, redo: [...stacks.redo, current] },
	};
}

/**
 * Redo: re-apply the most recently undone state, pushing `current` back onto
 * history. Returns null when there's nothing to redo (caller keeps `current`).
 */
export function redoEdit(
	stacks: EditStacks,
	current: RawCutSegment[],
): { segments: RawCutSegment[]; stacks: EditStacks } | null {
	if (stacks.redo.length === 0) return null;
	const redo = stacks.redo.slice(0, -1);
	const segments = stacks.redo[stacks.redo.length - 1];
	return {
		segments,
		stacks: { history: [...stacks.history, current], redo },
	};
}
