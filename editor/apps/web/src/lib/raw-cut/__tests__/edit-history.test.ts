import { describe, expect, it } from "bun:test";
import { recordEdit, redoEdit, undoEdit } from "../edit-history";
import type { RawCutSegment } from "../segments";

// A "state" in the stacks is a full segment list; for these tests we only need
// distinct, identity-comparable arrays, so a one-segment list per state suffices.
const state = (id: string): RawCutSegment[] => [
	{
		id,
		startSec: 0,
		endSec: 1,
		status: "keep",
		locked: false,
		marked: false,
	},
];
const A = state("A");
const B = state("B");
const C = state("C");

describe("recordEdit", () => {
	it("pushes the previous state onto history", () => {
		expect(recordEdit({ history: [], redo: [] }, A)).toEqual({
			history: [A],
			redo: [],
		});
	});

	it("clears the redo stack on a new edit (new branch)", () => {
		expect(recordEdit({ history: [A], redo: [B, C] }, A)).toEqual({
			history: [A, A],
			redo: [],
		});
	});

	it("caps history at `cap`, dropping the oldest", () => {
		const history = Array.from({ length: 100 }, (_, i) => state(`h${i}`));
		const result = recordEdit({ history, redo: [] }, A, { cap: 100 });
		expect(result.history.length).toBe(100);
		expect(result.history[99]).toBe(A);
		expect(result.history[0]).toBe(history[1]); // h0 dropped
	});

	it("does not cap when no cap is given (raw-cut toggleIndex parity)", () => {
		const history = Array.from({ length: 100 }, (_, i) => state(`h${i}`));
		const result = recordEdit({ history, redo: [] }, A);
		expect(result.history.length).toBe(101);
	});
});

describe("undoEdit", () => {
	it("returns null when there is nothing to undo", () => {
		expect(undoEdit({ history: [], redo: [] }, A)).toBeNull();
	});

	it("restores the last history state and pushes current onto redo", () => {
		expect(undoEdit({ history: [A, B], redo: [] }, C)).toEqual({
			segments: B,
			stacks: { history: [A], redo: [C] },
		});
	});
});

describe("redoEdit", () => {
	it("returns null when there is nothing to redo", () => {
		expect(redoEdit({ history: [A], redo: [] }, B)).toBeNull();
	});

	it("re-applies the last redo state and pushes current onto history", () => {
		expect(redoEdit({ history: [A], redo: [C] }, B)).toEqual({
			segments: C,
			stacks: { history: [A, B], redo: [] },
		});
	});
});

describe("edit → undo → redo roundtrip", () => {
	it("returns to the edited state", () => {
		// Edited from A to B: record A, segments now B.
		const afterEdit = recordEdit({ history: [], redo: [] }, A);
		const undone = undoEdit(afterEdit, B);
		if (!undone) throw new Error("expected undo to produce a state");
		expect(undone).toEqual({ segments: A, stacks: { history: [], redo: [B] } });
		const redone = redoEdit(undone.stacks, undone.segments);
		expect(redone).toEqual({ segments: B, stacks: { history: [A], redo: [] } });
	});
});
