// Chunked raw-footage analysis — the engine behind /api/final-pass mode:"raw".
// One Gemini call over a 65-min transcript "region-paints" (16 cuts averaging
// 2.6 min instead of the ~40-100 sentence-level cuts a real edit needs), so:
//
//   • the transcript is tiled into ~12-min windows with ~1-min overlap and each
//     window gets its own full-attention call;
//   • one extra WHOLE-FILE pass hunts cross-distance retakes only (a CTA redone
//     8 minutes later is invisible inside any single window — last take wins);
//   • cuts are merged across calls: duplicates from overlapping windows and the
//     retake pass dedupe by span overlap, keeping the highest-priority kind and
//     confidence. Score/verdict come from the whole-file pass.
//
// Pure logic (windowing, clamping, dedup, prompts) is model-free and
// unit-tested in __tests__/raw-analysis.test.ts; the caller supplies callModel.

export interface RawTranscriptSegment {
	text: string;
	start: number;
	end: number;
}

export interface RawCut {
	start: number;
	end: number;
	reason: string;
	kind: string;
	confidence: number;
}

export interface RawAnalysisResult {
	score: number;
	reason: string;
	cuts: RawCut[];
}

export const RAW_KINDS = [
	"marker",
	"retake",
	"false-start",
	"filler",
	"tangent",
	"fluff",
] as const;

// When two calls describe the same span with different kinds, the kind that
// carries the most edit intent wins (a marker IS the creator's own decision).
const KIND_PRIORITY: Record<string, number> = {
	marker: 5,
	retake: 4,
	"false-start": 3,
	filler: 2,
	tangent: 1,
	fluff: 0,
};

export const DEFAULT_WINDOW_SEC = 720; // ~12 min of transcript per call
export const DEFAULT_OVERLAP_SEC = 60; // boundary cuts land in both windows

export function planWindows({
	startSec,
	endSec,
	windowSec = DEFAULT_WINDOW_SEC,
	overlapSec = DEFAULT_OVERLAP_SEC,
}: {
	startSec: number;
	endSec: number;
	windowSec?: number;
	overlapSec?: number;
}): Array<{ start: number; end: number }> {
	if (endSec - startSec <= windowSec) {
		return [{ start: startSec, end: endSec }];
	}
	const stride = Math.max(1, windowSec - overlapSec);
	const windows: Array<{ start: number; end: number }> = [];
	for (let s = startSec; ; s += stride) {
		const e = s + windowSec;
		if (e >= endSec) {
			windows.push({ start: s, end: endSec });
			break;
		}
		windows.push({ start: s, end: e });
	}
	return windows;
}

/** Cuts a window call returns must live inside that window — clamp partials,
 *  drop hallucinations entirely outside the range. */
export function clampCutsToRange<T extends { start: number; end: number }>(
	cuts: T[],
	range: { start: number; end: number },
): T[] {
	const out: T[] = [];
	for (const c of cuts) {
		const start = Math.max(c.start, range.start);
		const end = Math.min(c.end, range.end);
		if (end > start) out.push({ ...c, start, end });
	}
	return out;
}

/**
 * Merge duplicate cuts across calls. Two cuts are the same finding when their
 * overlap covers at least half of the smaller span; the merged cut is the
 * union span, the max confidence, and the higher-priority kind's reason.
 */
export function dedupeCuts<
	T extends {
		start: number;
		end: number;
		kind: string;
		reason: string;
		confidence: number;
	},
>(cuts: T[]): T[] {
	if (cuts.length <= 1) return cuts.slice();
	const sorted = cuts.slice().sort((a, b) => a.start - b.start);
	const out: T[] = [{ ...sorted[0] }];
	for (let i = 1; i < sorted.length; i++) {
		const prev = out[out.length - 1];
		const cur = sorted[i];
		const overlap =
			Math.min(prev.end, cur.end) - Math.max(prev.start, cur.start);
		const minDur = Math.min(prev.end - prev.start, cur.end - cur.start);
		if (overlap > 0 && minDur > 0 && overlap >= minDur / 2) {
			const winner =
				(KIND_PRIORITY[cur.kind] ?? 0) > (KIND_PRIORITY[prev.kind] ?? 0)
					? cur
					: prev;
			prev.start = Math.min(prev.start, cur.start);
			prev.end = Math.max(prev.end, cur.end);
			prev.kind = winner.kind;
			prev.reason = winner.reason;
			prev.confidence = Math.max(prev.confidence, cur.confidence);
		} else {
			out.push({ ...cur });
		}
	}
	return out;
}

export function clampScore(n: unknown): number {
	const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
	return Math.round(Math.max(1, Math.min(10, v)) * 10) / 10;
}

/** Coerce a model response's cuts into valid RawCuts (same tolerances the
 *  route always applied: junk kind → fluff, junk confidence → review band). */
export function sanitizeRawCuts(cuts: unknown): RawCut[] {
	const validKinds: readonly string[] = RAW_KINDS;
	return (Array.isArray(cuts) ? cuts : [])
		.filter(
			(c) =>
				typeof c?.start === "number" &&
				typeof c?.end === "number" &&
				(c.end as number) > (c.start as number),
		)
		.map((c) => ({
			start: c.start as number,
			end: c.end as number,
			reason: String(c.reason ?? ""),
			kind: validKinds.includes(c.kind ?? "") ? (c.kind as string) : "fluff",
			confidence:
				typeof c.confidence === "number" && Number.isFinite(c.confidence)
					? Math.max(0, Math.min(1, c.confidence))
					: 0.7,
		}));
}

export function formatTranscript(segments: RawTranscriptSegment[]): string {
	return segments
		.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text.trim()}`)
		.join("\n");
}

export function buildRawPrompt({
	transcript,
	rulebook,
	outline,
	window,
	focus,
}: {
	transcript: string;
	rulebook?: string;
	outline?: string;
	window?: { index: number; count: number; start: number; end: number };
	focus?: "retakes";
}): string {
	const rules = rulebook?.trim();
	const rulesBlock = rules
		? [
				"",
				"LEARNED EDITOR PREFERENCES — the creator wrote these rules about how",
				"THEY want cuts made. Follow them; where they conflict with your default",
				"instincts, the creator's rules WIN:",
				rules,
				"",
			]
		: [];
	const plan = outline?.trim();
	const outlineBlock = plan
		? [
				"",
				"VIDEO OUTLINE — the creator's plan for this video. Use it to tell a",
				"tangent from the actual point. Do NOT cut content merely because it",
				"isn't in the outline (filming reveals new beats); cut it only when it",
				"doesn't serve the video:",
				plan,
				"",
			]
		: [];
	const genreBlock = [
		"",
		"GENRE — SCREEN-DEMO / BUILD VIDEO: the creator narrates over a screen",
		'recording while building and testing things. Narration-over-screen ("here',
		'you can see", "let\'s take a look", "so what just happened is") IS the',
		"content of this format, NOT filler — never cut walkthrough narration for",
		"being demonstrative, and never cut a setup beat that pays off a promise",
		"made in the intro. Specifics the audience watches this format FOR —",
		"costs, usage limits, plan names, model settings, timings, view counts —",
		"are content, never billing/config fluff. Personality asides and jokes",
		"that land back on topic within a couple of sentences are KEEPS, not",
		"tangents — a tangent must derail the video, not color it; comparing the",
		"built thing to a real-world reference (a real product, watch, game) is",
		"demo content. Silences and dead air are ALREADY handled by a separate",
		"silence pass — never cut a span because its bracket timing implies a",
		"gap; judge only the words. Cut demo narration only when it is a true",
		"retake / false start, or repeats something already shown.",
		"",
	];
	const windowBlock = window
		? [
				"",
				`WINDOW CONTEXT: you are seeing WINDOW ${window.index + 1} of ${window.count},`,
				`covering ${window.start.toFixed(0)}s–${window.end.toFixed(0)}s of a longer video. Neighboring`,
				"windows are analyzed separately. ONLY return cuts that start AND end",
				"inside this window's range; do not speculate about footage outside it.",
				"",
			]
		: [];
	const confidenceBlock = [
		"",
		"2) YOUR CUTS APPLY DIRECTLY — there is no human review queue. Return",
		"   ONLY cuts you would COMMIT as the final editor; when in doubt, keep",
		"   the footage and return nothing for it. For each cut also return a",
		"   confidence 0.0–1.0 — how certain a good editor would be that this",
		"   MUST go:",
		"   - 0.95+: unmistakable (verbatim retake, abandoned sentence).",
		"   - 0.85–0.95: clear to any competent editor.",
		"   - 0.65–0.85: probable — you still stand behind cutting it.",
		"   - below 0.65: do NOT return it; that is a keep.",
		"",
		"3) SCORE 1.0–10.0 (one decimal): the quality this footage can reach",
		"   AFTER your cuts are applied — hook, pacing, payoff, clarity. Be a",
		"   harsh, honest critic; default to the 5–6 band unless it genuinely",
		"   earns more. Give a one-sentence reason naming the biggest weakness.",
		"",
		"TRANSCRIPT:",
		transcript,
	];

	if (focus === "retakes") {
		return [
			"You are a RUTHLESS YouTube editor reading the FULL transcript of RAW",
			"footage straight off the camera (silences already removed; seconds in",
			"brackets). Return ONLY JSON matching the schema.",
			...rulesBlock,
			...outlineBlock,
			...genreBlock,
			"",
			"1) FOCUS — CROSS-DISTANCE RETAKES ONLY. This pass exists because the",
			"   creator re-records lines, sections, intros and CTAs MINUTES apart —",
			"   the redo can be 5–10 minutes after the flubbed original. Read the",
			"   whole transcript and find every line/section/CTA attempted more than",
			"   once, however far apart the attempts are. The LAST take wins; cut",
			'   every earlier attempt (kind "retake"), including any meta line that',
			'   announces the redo ("let me actually do the call to action a',
			'   different way"). Wording differs between takes — match on intent,',
			"   not exact words. If the last attempt is itself abandoned, keep the",
			"   best complete one instead. Do NOT return filler / tangent / fluff /",
			"   single-sentence stumbles here — separate passes handle those.",
			...confidenceBlock,
		].join("\n");
	}

	return [
		"You are a RUTHLESS YouTube editor doing the FIRST content pass on RAW",
		"footage straight off the camera (silences were already removed). The",
		"creator films in takes: the same line is often attempted several times,",
		"sentences get abandoned and restarted, and there are tangents and",
		"rambles. Your job: find every region to CUT so what remains is the",
		"final edit. Below is the timestamped transcript (seconds). Return ONLY",
		"JSON matching the schema.",
		...rulesBlock,
		...outlineBlock,
		...genreBlock,
		...windowBlock,
		"",
		"1) Find EVERY region to CUT — exhaustive, end to end. Cut at the",
		"   sentence/phrase level, not in region-sized blocks: a minute of raw",
		"   talking typically holds 1-2 cuttable moments; if you found only a",
		"   handful, re-scan. Kinds:",
		'   - "marker": the creator NARRATES his own edit. Spoken edit commands',
		'     ("cut that out", "don\'t show this", "let me say that again", "let',
		'     me say this instead", "no, don\'t say that", "oops", "wait, hold',
		'     on", or directly addressing the editor by name — transcription',
		"     often mangles names, so treat near-homophones of the same name as",
		"     that name). Cut the command itself AND the flubbed content it",
		"     refers to — extend the cut BACKWARD to the start of the take being",
		"     redone AND FORWARD to exactly where the redo begins; the redo after",
		"     the marker is the keeper. These are the highest-confidence cuts in",
		"     any raw file — hunt for every single one.",
		'   - "retake": the same line/idea attempted more than once. Cut every',
		"     attempt EXCEPT THE LAST — the last take is the keeper (the creator",
		"     re-records until satisfied). Wording will differ between takes;",
		"     match on intent, not exact words. If the last attempt is itself",
		"     abandoned, keep the best complete one instead.",
		'   - "false-start": a sentence abandoned midway and restarted. Cut from',
		"     the start of the abandoned attempt FORWARD to where the keeper take",
		'     begins — include any apology ("sorry") and dead air between flub',
		"     and redo, never just the first few words.",
		'   - "filler": um/uh/you-know runs, throat-clearing, "okay so" ramp-ups.',
		"   - \"tangent\": a detour that doesn't serve the video's point.",
		'   - "fluff": rambling, over-explanation, redundant restatement, weak',
		"     low-information runs a viewer would skip. When the same reaction or",
		"     complaint is restated several times, keep ONLY the most specific",
		"     restatement and cut every other one.",
		"   For each cut return start/end in seconds drawn from the transcript",
		"   ranges and a short, specific reason. In every kind: an apology or",
		'   redo announcement ("sorry", "let me say that again", "wait") is',
		"   NEVER part of the keeper — it always belongs inside the cut, with",
		"   the keep resuming right after it.",
		...confidenceBlock,
	].join("\n");
}

/**
 * Run the full chunked analysis. Short transcripts (≤ one window) make a
 * single standard call; long ones fan out into window calls plus the
 * whole-file retake pass, then merge. callModel must resolve to the parsed
 * JSON object for one model call (score/verdict/reason/cuts).
 */
export async function runRawAnalysis({
	segments,
	rulebook,
	outline,
	windowSec = DEFAULT_WINDOW_SEC,
	overlapSec = DEFAULT_OVERLAP_SEC,
	callModel,
}: {
	segments: RawTranscriptSegment[];
	rulebook?: string;
	outline?: string;
	windowSec?: number;
	overlapSec?: number;
	callModel: (prompt: string) => Promise<unknown>;
}): Promise<RawAnalysisResult> {
	const sorted = segments.slice().sort((a, b) => a.start - b.start);
	const startSec = sorted[0]?.start ?? 0;
	const endSec = sorted.reduce((m, s) => Math.max(m, s.end), startSec);
	const windows = planWindows({ startSec, endSec, windowSec, overlapSec });

	type ModelResponse = {
		score?: unknown;
		reason?: unknown;
		cuts?: unknown;
	};

	if (windows.length === 1) {
		const resp = (await callModel(
			buildRawPrompt({
				transcript: formatTranscript(sorted),
				rulebook,
				outline,
			}),
		)) as ModelResponse;
		return {
			score: clampScore(resp?.score),
			reason: String(resp?.reason ?? ""),
			cuts: dedupeCuts(sanitizeRawCuts(resp?.cuts)),
		};
	}

	const windowCalls = windows.map((w, i) => {
		const slice = sorted.filter((s) => s.start < w.end && s.end > w.start);
		return callModel(
			buildRawPrompt({
				transcript: formatTranscript(slice),
				rulebook,
				outline,
				window: { index: i, count: windows.length, start: w.start, end: w.end },
			}),
		).then((resp) =>
			clampCutsToRange(sanitizeRawCuts((resp as ModelResponse)?.cuts), w),
		);
	});
	const retakeCall = callModel(
		buildRawPrompt({
			transcript: formatTranscript(sorted),
			rulebook,
			outline,
			focus: "retakes",
		}),
	);

	const [windowCuts, retakeResp] = await Promise.all([
		Promise.all(windowCalls),
		retakeCall,
	]);
	const retake = retakeResp as ModelResponse;
	const allCuts = [
		...windowCuts.flat(),
		...clampCutsToRange(sanitizeRawCuts(retake?.cuts), {
			start: startSec,
			end: endSec,
		}),
	];

	return {
		score: clampScore(retake?.score),
		reason: String(retake?.reason ?? ""),
		cuts: dedupeCuts(allCuts),
	};
}
