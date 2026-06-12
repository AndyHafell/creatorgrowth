// Raw Cut's AI content pass — the model layer between /api/final-pass
// (mode:"raw") and the Raw Cut surface. Replaces the old Jaccard double-take
// detector: Gemini reads the full transcript, so reworded retakes, false
// starts, tangents and fluff all come back as timestamped cuts with a
// confidence. High-confidence MECHANICAL cuts auto-apply (same trust level as
// silence removal); everything else queues as a blue suggestion for Y/N review.

import type { Cut } from "@/components/editor/final-pass/final-pass-cache";
import type { TranscriptionSegment } from "@/lib/transcription/types";

export type AiCutKind = Cut["kind"];

// Transcription-cache model ids. CLOUD_MODEL_ID matches Final Pass's full-clip
// Scribe cache (so a clip transcribed there is an instant hit here); the
// -rawcut variant holds the SPLICED (keeps-only) transcript so it never
// pollutes the full-clip cache Final Pass restores from.
export const CLOUD_MODEL_ID = "elevenlabs-scribe_v1";
export const RAWCUT_CLOUD_MODEL_ID = "elevenlabs-scribe_v1-rawcut";

/**
 * Transcription-cache read order for the AI pass. With an ElevenLabs key the
 * whisper entry is EXCLUDED — never feed Gemini a whisper-tiny transcript just
 * because it's cached (tiny collapses back-to-back retakes into one segment
 * and clips word tails; a stale hit here cost Andy a missed double take at
 * 1:02→1:06). Re-transcribing with Scribe beats reusing a tiny transcript.
 */
export function transcriptCacheModelIds({
	hasElevenKey,
	whisperModelId,
}: {
	hasElevenKey: boolean;
	whisperModelId: string;
}): string[] {
	const ids = [CLOUD_MODEL_ID, RAWCUT_CLOUD_MODEL_ID];
	if (!hasElevenKey) ids.push(whisperModelId);
	return ids;
}

export interface AiCutSuggestion {
	id: string;
	startSec: number;
	endSec: number;
	/** What's being cut — transcript excerpt for the row. */
	text: string;
	kind: AiCutKind;
	reason: string;
	confidence: number;
}

// Red-or-nothing (Andy, 2026-06-11): no blue review queue — "just red or
// black, there is no in between". Every cut at/above the floor is applied
// directly, whatever the kind or span; below-floor finds are DROPPED, not
// queued. The prompt tells the model to only return cuts it would commit as
// the final editor, so the floor is a backstop against junk, not the decider.
export const APPLY_CONFIDENCE_FLOOR = 0.65;

export function shouldApplyCut(cut: Cut): boolean {
	return (cut.confidence ?? 0) >= APPLY_CONFIDENCE_FLOOR;
}

/** Transcript excerpt overlapping [start, end] — the suggestion row's text. */
export function excerptForRange(
	segments: TranscriptionSegment[],
	start: number,
	end: number,
	maxChars = 220,
): string {
	const parts: string[] = [];
	for (const s of segments) {
		if (s.start < end && s.end > start) parts.push(s.text.trim());
		if (s.start >= end) break;
	}
	const joined = parts.join(" ").replace(/\s+/g, " ").trim();
	return joined.length > maxChars
		? `${joined.slice(0, maxChars - 1)}…`
		: joined;
}

export function toSuggestions(
	cuts: Cut[],
	segments: TranscriptionSegment[],
): AiCutSuggestion[] {
	return cuts.map((c, i) => ({
		id: `ai-${c.start.toFixed(2)}-${i}`,
		startSec: c.start,
		endSec: c.end,
		text: excerptForRange(segments, c.start, c.end),
		kind: c.kind,
		reason: c.reason,
		confidence: c.confidence ?? 0.7,
	}));
}

// --- External cut lists ------------------------------------------------------
// "Import cuts" lets any outside editor (Claude Code agent, another tool, a
// teammate) hand Raw Cut a cut list as JSON: {cuts: [{start, end, kind, reason,
// confidence, text?}]} in MEDIA seconds. Same auto-apply/review split as the
// built-in AI pass.

export interface ImportedCut extends Cut {
	text?: string;
}

const VALID_KINDS: ReadonlySet<string> = new Set([
	"retake",
	"false-start",
	"filler",
	"tangent",
	"fluff",
	"marker",
]);

export function parseImportedCuts(raw: string): ImportedCut[] {
	let data: { cuts?: unknown };
	try {
		data = JSON.parse(raw) as { cuts?: unknown };
	} catch {
		throw new Error("Not valid JSON.");
	}
	const list = Array.isArray(data.cuts) ? data.cuts : [];
	const cuts: ImportedCut[] = [];
	for (const c of list as Array<Record<string, unknown>>) {
		if (typeof c?.start !== "number" || typeof c?.end !== "number") continue;
		if (!(c.end > c.start)) continue;
		cuts.push({
			start: c.start,
			end: c.end,
			reason: String(c.reason ?? ""),
			kind: VALID_KINDS.has(String(c.kind))
				? (String(c.kind) as AiCutKind)
				: "fluff",
			confidence:
				typeof c.confidence === "number" && Number.isFinite(c.confidence)
					? Math.max(0, Math.min(1, c.confidence))
					: 0.7,
			text: typeof c.text === "string" ? c.text : undefined,
		});
	}
	return cuts;
}

/** Imported cuts may carry their own row text (no transcript needed). */
export function importedToSuggestions(
	cuts: ImportedCut[],
	segments: TranscriptionSegment[],
): AiCutSuggestion[] {
	return cuts.map((c, i) => ({
		id: `imp-${c.start.toFixed(2)}-${i}`,
		startSec: c.start,
		endSec: c.end,
		text: c.text ?? excerptForRange(segments, c.start, c.end),
		kind: c.kind,
		reason: c.reason,
		confidence: c.confidence ?? 0.7,
	}));
}
