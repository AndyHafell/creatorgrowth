import type { BeatCandidate, MagicKind, TimelineWord } from "./types";

// Transcript-only beat detection. Pure — vision refinement happens later in
// the /api/magic-pass route; these phrases just decide WHERE a Magic clip is
// worth proposing and what kind. Tuned for Andy's screen-recording narration
// style ("look at this", "this prompt", "on the right side ...").

interface PhraseRule {
	tokens: string[];
	kind: MagicKind;
	strength: 1 | 2;
}

function rules(
	kind: MagicKind,
	strength: 1 | 2,
	phrases: string[],
): PhraseRule[] {
	return phrases.map((p) => ({ tokens: p.split(" "), kind, strength }));
}

const PHRASE_RULES: PhraseRule[] = [
	...rules("zoom", 2, [
		"look at",
		"looking at",
		"look here",
		"look over here",
		"over here",
		"right here",
		"up here",
		"down here",
		"right there",
		"zoom in",
		"zoom into",
		"focus on",
		"as you can see",
		"check this out",
		"check out",
		"watch this",
		"click this",
		"click here",
		"click on",
		"i click",
		"we click",
		"see how",
		"show you",
	]),
	...rules("zoom", 1, [
		"you can see",
		"can see",
		"see this",
		"this button",
		"this part",
		"this area",
		"this section",
		"this tab",
		"this panel",
		"this page",
		"this screen",
		"this window",
		"this little",
		"this one",
		"right side",
		"left side",
		"top right",
		"top left",
		"bottom right",
		"bottom left",
		"in the corner",
	]),
	...rules("highlight", 2, [
		"this prompt",
		"this line",
		"this code",
		"this command",
		"this text",
		"this sentence",
		"this paragraph",
		"read this",
	]),
	...rules("highlight", 1, [
		"this number",
		"this setting",
		"these settings",
		"this field",
		"this option",
		"this box",
		"this value",
		"this file",
		"this error",
		"this message",
	]),
];

// Direction words → percent-space focal bias. Only counted near a match.
const X_HINTS: Record<string, number> = { right: 72, left: 28 };
const Y_HINTS: Record<string, number> = {
	top: 30,
	up: 30,
	upper: 30,
	bottom: 72,
	down: 72,
	lower: 72,
};

function normalize(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

interface Match {
	rule: PhraseRule;
	wordStart: number;
	wordEnd: number;
}

function findMatches(tokens: string[]): Match[] {
	const matches: Match[] = [];
	for (let i = 0; i < tokens.length; i++) {
		for (const rule of PHRASE_RULES) {
			const len = rule.tokens.length;
			if (i + len > tokens.length) continue;
			let ok = true;
			for (let j = 0; j < len; j++) {
				if (tokens[i + j] !== rule.tokens[j]) {
					ok = false;
					break;
				}
			}
			if (ok) matches.push({ rule, wordStart: i, wordEnd: i + len - 1 });
		}
	}
	return matches;
}

/** Overlapping/adjacent matches collapse to one: highlight > strength > length. */
function collapseOverlaps(matches: Match[]): Match[] {
	const sorted = [...matches].sort((a, b) => a.wordStart - b.wordStart);
	const groups: Match[][] = [];
	for (const m of sorted) {
		const group = groups[groups.length - 1];
		const last = group?.[group.length - 1];
		if (last && m.wordStart <= last.wordEnd + 1) {
			group.push(m);
		} else {
			groups.push([m]);
		}
	}
	return groups.map((group) =>
		group.reduce((best, m) => {
			if (m.rule.kind !== best.rule.kind) {
				return m.rule.kind === "highlight" ? m : best;
			}
			if (m.rule.strength !== best.rule.strength) {
				return m.rule.strength > best.rule.strength ? m : best;
			}
			return m.rule.tokens.length > best.rule.tokens.length ? m : best;
		}),
	);
}

function focalHintNear({
	tokens,
	wordStart,
	wordEnd,
}: {
	tokens: string[];
	wordStart: number;
	wordEnd: number;
}): { x: number; y: number } | null {
	const from = Math.max(0, wordStart - 4);
	const to = Math.min(tokens.length - 1, wordEnd + 4);
	let x: number | null = null;
	let y: number | null = null;
	for (let i = from; i <= to; i++) {
		if (x === null && tokens[i] in X_HINTS) x = X_HINTS[tokens[i]];
		if (y === null && tokens[i] in Y_HINTS) y = Y_HINTS[tokens[i]];
	}
	if (x === null && y === null) return null;
	return { x: x ?? 50, y: y ?? 50 };
}

/**
 * Natural cut points for splitting long reframe stretches: silence gaps
 * (boundary at the midpoint of the gap) and sentence-final punctuation
 * (boundary at the word end). Sorted, deduped, timeline seconds.
 */
export function detectBoundaries({
	words,
	minSilenceSec = 1.5,
}: {
	words: TimelineWord[];
	minSilenceSec?: number;
}): number[] {
	const bounds = new Set<number>();
	for (let i = 0; i < words.length - 1; i++) {
		const word = words[i];
		const next = words[i + 1];
		if (/[.?!]["')\]]?$/.test(word.text)) bounds.add(word.end);
		const gap = next.start - word.end;
		if (gap >= minSilenceSec) bounds.add(word.end + gap / 2);
	}
	return [...bounds].sort((a, b) => a - b);
}

export function detectBeats({
	words,
}: {
	words: TimelineWord[];
}): BeatCandidate[] {
	const tokens = words.map((w) => normalize(w.text));
	const matches = collapseOverlaps(findMatches(tokens));
	return matches.map((m) => {
		const phrase = m.rule.tokens.join(" ");
		const excerptFrom = Math.max(0, m.wordStart - 3);
		const excerptTo = Math.min(words.length - 1, m.wordEnd + 5);
		const excerpt = words
			.slice(excerptFrom, excerptTo + 1)
			.map((w) => w.text)
			.join(" ");
		return {
			kind: m.rule.kind,
			triggerStart: words[m.wordStart].start,
			triggerEnd: words[m.wordEnd].end,
			reason: `"${phrase}" — ${excerpt}`,
			focalHint: focalHintNear({
				tokens,
				wordStart: m.wordStart,
				wordEnd: m.wordEnd,
			}),
			strength: m.rule.strength,
		};
	});
}
