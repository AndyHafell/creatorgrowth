// Final-Pass-owned persistence. Two jobs, both aimed at "stop making Andy
// pay/redo work he already did":
//
//  1) Survive-reload transcription. The shared OPFS transcription cache
//     (lib/raw-cut/transcription-cache) is keyed by the file's CONTENT hash.
//     After a page reload the `asset.file` handle can go stale, so
//     `computeFileHash()` throws and we lose the key → the cache is skipped and
//     the whole clip re-transcribes (Andy's annoyance). We keep a tiny
//     localStorage pointer assetId → contentHash, written on every successful
//     hash, so a stale handle can still recover the key and hit the existing
//     OPFS entry written by either Final Pass or Raw Cut.
//
//  2) Don't re-bill Gemini. The analysis (`/api/final-pass`) costs money. We
//     persist {score, verdict, reason, cuts} per asset keyed by a transcript
//     signature, so re-opening a clip restores the cuts/score instantly with no
//     API call. Only an explicit Re-analyze forces a fresh call.

import type { RawCutSegmentState } from "@/lib/raw-cut/session-cache";
import type { TranscriptionSegment } from "@/lib/transcription/types";

export type Cut = {
	start: number;
	end: number;
	reason: string;
	// "retake" | "false-start" | "tangent" | "marker" only come back from
	// mode:"raw" (Raw Cut's AI pass); Final Pass still gets fluff/filler.
	// "marker" = spoken edit commands ("cut that out", "let me say that again",
	// direct address to the editor) — the creator narrating his own edit.
	kind: "fluff" | "filler" | "retake" | "false-start" | "tangent" | "marker";
	// 0–1, raw mode. Optional so pre-existing cached analyses still parse.
	confidence?: number;
};

export type Analysis = {
	score: number;
	verdict: string;
	reason: string;
	cuts: Cut[];
};

// A YouTube-style chapter marker: a time (seconds) + a short title. Andy verifies
// the title/time in Final Pass, then exports them straight into the description.
// `id` is a client-side stable key for the editable list (kept across renames so
// the title input doesn't lose focus); the AI route returns chapters without it.
export type Chapter = {
	id?: string;
	time: number;
	title: string;
};

// A purple FEEDBACK marker: a moment Andy flags with a note ("2:34 - tighten
// this"). The note is auto-prefixed with the MM:SS timestamp on creation so the
// learning loop (Part B) knows exactly where it applies. `time` is media seconds
// (drives the pin + drag). `id` is a stable client key for the editable list.
export type FeedbackMarker = {
	id: string;
	time: number;
	note: string;
};

// The per-user "cut rules" rulebook (Part B v1): free text the editor injects
// into every first-pass cut prompt as LEARNED EDITOR PREFERENCES, so the AI cuts
// the way Andy wants. Browser-global (one key, not per-asset) — the editor + main
// CG run on one account, so a later version can sync this to the CG account.
const RULEBOOK_KEY = "finalpass:rulebook";

const HASH_PTR_PREFIX = "finalpass:idhash:";
const ANALYSIS_PREFIX = "finalpass:analysis:";
const CHAPTERS_PREFIX = "finalpass:chapters:";
const SEGMENTS_PREFIX = "finalpass:segments:";
const FEEDBACK_PREFIX = "finalpass:feedback:";

function ls(): Storage | null {
	try {
		return typeof localStorage !== "undefined" ? localStorage : null;
	} catch {
		return null;
	}
}

/** Remember the content hash we computed for this asset, so a later stale
 *  File handle (post-reload) can still recover the transcription-cache key. */
export function rememberContentHash(assetId: string, hash: string): void {
	try {
		ls()?.setItem(HASH_PTR_PREFIX + assetId, hash);
	} catch {
		/* best-effort */
	}
}

export function recallContentHash(assetId: string): string | null {
	try {
		return ls()?.getItem(HASH_PTR_PREFIX + assetId) ?? null;
	} catch {
		return null;
	}
}

// Cheap, stable signature of the transcript text+timing (djb2). The analysis is
// a pure function of the transcript, so this is the analysis-cache key — a
// re-transcribe that changes the text changes the signature and invalidates it.
export function hashTranscript(segments: TranscriptionSegment[]): string {
	let h = 5381;
	for (const s of segments) {
		const line = `${s.start.toFixed(1)}|${s.end.toFixed(1)}|${s.text.trim()}`;
		for (let i = 0; i < line.length; i++) {
			h = (h * 33 + line.charCodeAt(i)) | 0;
		}
	}
	return `${(h >>> 0).toString(36)}_${segments.length}`;
}

interface AnalysisCacheEntry {
	version: 1;
	transcriptHash: string;
	analysis: Analysis;
	createdAt: number;
}

// Keyed by the file's CONTENT HASH (not asset id), so re-importing the same clip
// — which mints a fresh asset id — still restores the score + cuts instead of
// re-billing Gemini. Same robustness the transcription cache already has.
export function readAnalysisCache({
	contentHash,
	transcriptHash,
}: {
	contentHash: string;
	transcriptHash: string;
}): Analysis | null {
	const store = ls();
	if (!store) return null;
	try {
		const raw = store.getItem(ANALYSIS_PREFIX + contentHash);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as AnalysisCacheEntry;
		if (parsed.version !== 1) return null;
		if (parsed.transcriptHash !== transcriptHash) return null;
		return parsed.analysis;
	} catch {
		return null;
	}
}

export function writeAnalysisCache({
	contentHash,
	transcriptHash,
	analysis,
}: {
	contentHash: string;
	transcriptHash: string;
	analysis: Analysis;
}): void {
	const store = ls();
	if (!store) return;
	const entry: AnalysisCacheEntry = {
		version: 1,
		transcriptHash,
		analysis,
		createdAt: Date.now(),
	};
	try {
		store.setItem(ANALYSIS_PREFIX + contentHash, JSON.stringify(entry));
	} catch {
		/* best-effort */
	}
}

interface ChaptersCacheEntry {
	version: 1;
	transcriptHash: string;
	chapters: Chapter[];
	createdAt: number;
}

// Chapters persist per asset keyed by transcript signature (same scheme as the
// analysis cache) AND survive Andy's manual edits: writeChaptersCache is also
// called after every rename / time-nudge, so a reload restores his tweaks, not
// just the raw AI output.
export function readChaptersCache({
	contentHash,
	transcriptHash,
}: {
	contentHash: string;
	transcriptHash: string;
}): Chapter[] | null {
	const store = ls();
	if (!store) return null;
	try {
		const raw = store.getItem(CHAPTERS_PREFIX + contentHash);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as ChaptersCacheEntry;
		if (parsed.version !== 1) return null;
		if (parsed.transcriptHash !== transcriptHash) return null;
		return Array.isArray(parsed.chapters) ? parsed.chapters : null;
	} catch {
		return null;
	}
}

export function writeChaptersCache({
	contentHash,
	transcriptHash,
	chapters,
}: {
	contentHash: string;
	transcriptHash: string;
	chapters: Chapter[];
}): void {
	const store = ls();
	if (!store) return;
	const entry: ChaptersCacheEntry = {
		version: 1,
		transcriptHash,
		chapters,
		createdAt: Date.now(),
	};
	try {
		store.setItem(CHAPTERS_PREFIX + contentHash, JSON.stringify(entry));
	} catch {
		/* best-effort */
	}
}

// Manual keep/cut edits — the work Andy does marking up the AI's cuts by hand.
// Without this they live only in memory and a reload wipes them (the data-loss
// bug). Keyed by ASSET ID, not content hash: the value must be readable
// SYNCHRONOUSLY at mount so it can seed useRawCutSegments' `initial` (the
// content hash is computed async, too late for the state initializer). A reload
// keeps the same asset id, so the cuts survive — this is a separate namespace
// from Raw Cut's session cache (its silence-based cuts differ from these
// AI-fluff cuts for the same clip). History is dropped (not worth persisting).
interface SegmentsCacheEntry {
	version: 1;
	segState: RawCutSegmentState;
	createdAt: number;
}

export function readSegmentsCache(assetId: string): RawCutSegmentState | null {
	const store = ls();
	if (!store) return null;
	try {
		const raw = store.getItem(SEGMENTS_PREFIX + assetId);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as SegmentsCacheEntry;
		if (parsed.version !== 1) return null;
		if (!Array.isArray(parsed.segState?.segments)) return null;
		return parsed.segState;
	} catch {
		return null;
	}
}

export function writeSegmentsCache(
	assetId: string,
	segState: RawCutSegmentState,
): void {
	const store = ls();
	if (!store) return;
	const entry: SegmentsCacheEntry = {
		version: 1,
		// Drop undo history — large and not worth persisting across a reload.
		segState: { ...segState, history: [] },
		createdAt: Date.now(),
	};
	try {
		store.setItem(SEGMENTS_PREFIX + assetId, JSON.stringify(entry));
	} catch {
		/* best-effort */
	}
}

// Purple feedback markers — Andy's hand-flagged notes. Keyed by ASSET ID (same
// scheme + reasoning as the segments cache: read synchronously at mount so the
// list restores instantly on reload, which keeps the same asset id). These notes
// are the high-signal input to the Part B cut-learning loop.
interface FeedbackCacheEntry {
	version: 1;
	markers: FeedbackMarker[];
	createdAt: number;
}

export function readFeedbackCache(assetId: string): FeedbackMarker[] | null {
	const store = ls();
	if (!store) return null;
	try {
		const raw = store.getItem(FEEDBACK_PREFIX + assetId);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as FeedbackCacheEntry;
		if (parsed.version !== 1) return null;
		return Array.isArray(parsed.markers) ? parsed.markers : null;
	} catch {
		return null;
	}
}

export function writeFeedbackCache(
	assetId: string,
	markers: FeedbackMarker[],
): void {
	const store = ls();
	if (!store) return;
	const entry: FeedbackCacheEntry = {
		version: 1,
		markers,
		createdAt: Date.now(),
	};
	try {
		store.setItem(FEEDBACK_PREFIX + assetId, JSON.stringify(entry));
	} catch {
		/* best-effort */
	}
}

// --- Cut rules rulebook (Part B v1) -----------------------------------------
export function readRulebook(): string {
	try {
		return ls()?.getItem(RULEBOOK_KEY) ?? "";
	} catch {
		return "";
	}
}

export function writeRulebook(text: string): void {
	try {
		ls()?.setItem(RULEBOOK_KEY, text);
	} catch {
		/* best-effort */
	}
}

// --- Server-backed rulebook (Part B v2) -------------------------------------
// The rulebook lives on the member's CreatorGrowth ACCOUNT (Flask, per-user), so
// it's multi-tenant + syncs across machines. localStorage above is a SYNC MIRROR:
// readRulebook() stays synchronous for the analyze() inject path, and
// loadRulebook() refreshes that mirror from the account. The Flask route is at
// the ROOT path (/api/...), NOT the editor's /editor basePath — same convention
// as /api/auth-status (see member-avatar.tsx).
const RULEBOOK_ENDPOINT = "/api/final-pass/rulebook";

/** Persist the rulebook to the account AND the local mirror. Mirror first so the
 *  inject path is instant and survives offline; the POST is best-effort. */
export async function saveRulebook(text: string): Promise<void> {
	writeRulebook(text);
	try {
		await fetch(RULEBOOK_ENDPOINT, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ rulebook: text }),
		});
	} catch {
		/* best-effort — the mirror keeps it locally until the next save */
	}
}

/** GET the account rulebook, refresh the mirror, return it. Falls back to the
 *  mirror when offline / unauthenticated / self-host (no Flask endpoint). One-time
 *  migration: if the account is empty but this browser has rules, push them up. */
export async function loadRulebook(): Promise<string> {
	try {
		const res = await fetch(RULEBOOK_ENDPOINT, { credentials: "include" });
		if (res.ok) {
			const data = (await res.json()) as { rulebook?: string };
			const server = data.rulebook ?? "";
			const mirror = readRulebook();
			if (!server.trim() && mirror.trim()) {
				await saveRulebook(mirror);
				return mirror;
			}
			writeRulebook(server);
			return server;
		}
	} catch {
		/* offline / self-host — fall back to the mirror */
	}
	return readRulebook();
}
