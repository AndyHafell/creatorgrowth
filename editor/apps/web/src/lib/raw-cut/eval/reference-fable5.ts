// Reference edit of "Fable 5.mp4" (65-min raw build video, 2026-06-11) —
// hand-built by a full read of the transcript; the grading spec for the Raw
// Cut AI engine. Spans in original media seconds. Source narrative:
// /tmp/fable5/reference_edit.md; importable cut list:
// ~/Downloads/claude_cuts_fable5.json.

import type { ReferenceEdit } from "./score";

export const FABLE5_REFERENCE: ReferenceEdit = {
	cuts: [
		// marker:true = the cut is announced by a spoken edit command (or driven
		// by one) — the engine must catch ~all of these.
		{ start: 0, end: 18, marker: false, label: "open take 1 (redo at 0:18)" },
		{
			start: 102,
			end: 119,
			marker: false,
			label: "doubled 'more information out of me'",
		},
		{ start: 1374, end: 1400, marker: false, label: "3rd lag complaint" },
		{ start: 1457, end: 1461, marker: false, label: "4th lag restatement" },
		{
			start: 1552,
			end: 1602,
			marker: false,
			label: "abandoned Intel intro + 'Sorry'",
		},
		{
			start: 2076,
			end: 2087,
			marker: true,
			label: "'no, don't say that' retraction",
		},
		{
			start: 2479,
			end: 2547,
			marker: true,
			label: "editor instructions (ordering, end screen)",
		},
		{
			start: 2547,
			end: 2572,
			marker: false,
			label: "'wait hold on' abandoned recap",
		},
		{
			start: 2665,
			end: 2673,
			marker: true,
			label: "'sorry I'm gonna say' redo marker",
		},
		{
			start: 2705,
			end: 3219,
			marker: true,
			label: "CTA take 1 + 'different way' meta line",
		},
		{
			start: 3309,
			end: 3334,
			marker: true,
			label: "editor instructions before intro take",
		},
		{
			start: 3520,
			end: 3596,
			marker: true,
			label: "June-22nd delivery take 1 + 'say that again'",
		},
		{
			start: 3765,
			end: 3820,
			marker: true,
			label: "'cut that out in the edit' self-flag",
		},
		{
			start: 3839,
			end: 3850,
			marker: true,
			label: "'Oops… go for it' restart",
		},
		{
			start: 3872,
			end: 3906,
			marker: true,
			label: "post-roll editor notes ('Hamflicks…')",
		},
	],
	keeps: [
		{
			start: 0,
			end: 152,
			label: "setup beat (usage-limit/$100 pays off the intro promise)",
			allowed: [
				{ start: 0, end: 18 },
				{ start: 102, end: 119 },
			],
		},
		{
			start: 673,
			end: 729,
			label: "Factory walkthrough narration (the demo IS the content)",
			allowed: [],
		},
		{
			start: 1004,
			end: 1035,
			label: "Casey Neistat watch aside (taste call — review ok, cut not)",
			allowed: [],
		},
		{
			start: 1066,
			end: 1089,
			label: "'one more prompt → 3D/Ikea' iteration-vision",
			allowed: [],
		},
	],
};
