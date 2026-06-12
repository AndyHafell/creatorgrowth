/**
 * Raw Cut session cache, keyed by media asset id. Two tiers:
 *
 *  • In-memory `Map` — survives the `RawCutSurface` unmount on an Edit↔Raw Cut
 *    switch (module scope outlives the component). Holds the full session incl.
 *    undo history.
 *  • localStorage — survives a full page reload / HMR (which wipes the Map).
 *    Holds a slimmed session (no undo history) as JSON. Synchronous, so the
 *    component's state initializers can restore the user's cuts at mount.
 *
 * Without this, flipping modes or a code reload would re-run the ~20s decode and
 * drop every keep/cut toggle. The decoded AudioBuffer is NOT here — it lives in
 * `decode-cache` (memory + OPFS); on reload it's restored from OPFS so the
 * costly decode is still skipped.
 */

import type { SilenceDetectionParams, SilenceRange } from "@/lib/media/audio";
import type { AiCutSuggestion } from "@/lib/raw-cut/ai-cut";
import type { RawCutSegment } from "@/lib/raw-cut/segments";
import type { DetectStatus } from "@/components/editor/raw-cut/transcription-panel";

/** Header readout from the AI cut pass (score/verdict/reason, sans cuts). */
export interface RawCutAiVerdict {
	score: number;
	verdict: string;
	reason: string;
}

export interface RawCutDetectionStats {
	silenceCount: number;
	silenceDurationSec: number;
	keepDurationSec: number;
	detectMs: number;
}

/** The editable segment list plus the bits needed to restore it without a
 *  detection-triggered rebuild clobbering the user's manual toggles. */
export interface RawCutSegmentState {
	segments: RawCutSegment[];
	history: RawCutSegment[][];
	builtSignature: string | null;
}

/** Everything `LoadedClip` needs to come back exactly as it was left. The
 *  decoded AudioBuffer is NOT here — it lives in `decode-cache` (memory + OPFS). */
export interface RawCutSession {
	decodeMs: number | null;
	params: SilenceDetectionParams;
	silenceRanges: SilenceRange[];
	stats: RawCutDetectionStats | null;
	// Applied AI-cut ranges (auto-applied + manually accepted). Field name kept
	// from the double-take era so existing persisted sessions restore cleanly.
	acceptedDoubleTakes: SilenceRange[];
	suggestions: AiCutSuggestion[];
	aiVerdict: RawCutAiVerdict | null;
	outline: string;
	detectStatus: DetectStatus;
	device: "webgpu" | "wasm" | null;
	/** Live cut channel code (Claude Code pipeline) — null when not linked. */
	liveChannel?: string | null;
	mediaDuration: number | null;
	currentTime: number;
	zoom: number;
	speed: number;
	segState: RawCutSegmentState;
}

const MAX_SESSIONS = 3;
const LS_PREFIX = "rawcut-session:";
const sessions = new Map<string, Partial<RawCutSession>>();

/** Undo history can be large and isn't worth persisting across a reload. */
function slim(session: Partial<RawCutSession>): Partial<RawCutSession> {
	if (!session.segState) return session;
	return {
		...session,
		segState: { ...session.segState, history: [] },
	};
}

function readLocal(assetId: string): Partial<RawCutSession> | undefined {
	if (typeof localStorage === "undefined") return undefined;
	try {
		const raw = localStorage.getItem(LS_PREFIX + assetId);
		return raw ? (JSON.parse(raw) as Partial<RawCutSession>) : undefined;
	} catch {
		return undefined;
	}
}

function writeLocal(assetId: string, session: Partial<RawCutSession>): void {
	if (typeof localStorage === "undefined") return;
	const payload = JSON.stringify(slim(session));
	try {
		localStorage.setItem(LS_PREFIX + assetId, payload);
	} catch {
		// Quota: drop other Raw Cut sessions and retry once.
		try {
			for (const k of Object.keys(localStorage)) {
				if (k.startsWith(LS_PREFIX) && k !== LS_PREFIX + assetId) {
					localStorage.removeItem(k);
				}
			}
			localStorage.setItem(LS_PREFIX + assetId, payload);
		} catch {
			/* give up — persistence is best-effort */
		}
	}
}

export function getRawCutSession(
	assetId: string,
): Partial<RawCutSession> | undefined {
	// Memory wins (full session incl. history); fall back to the durable copy
	// after a reload.
	return sessions.get(assetId) ?? readLocal(assetId);
}

/** Merge a patch into the session (creating it if absent), refresh its LRU
 *  position, and persist the durable copy. */
export function patchRawCutSession(
	assetId: string,
	patch: Partial<RawCutSession>,
): void {
	// Seed from the durable copy if memory was cleared (e.g. just after reload),
	// so a partial patch doesn't drop previously-restored fields.
	const existing = sessions.get(assetId) ?? readLocal(assetId);
	// Re-insert to move to the most-recent end of the Map's iteration order.
	sessions.delete(assetId);
	const merged = { ...existing, ...patch };
	sessions.set(assetId, merged);

	while (sessions.size > MAX_SESSIONS) {
		const oldest = sessions.keys().next().value;
		if (oldest === undefined) break;
		sessions.delete(oldest);
	}

	writeLocal(assetId, merged);
}

/** Drop a single asset's session (e.g. when the clip is removed). */
export function clearRawCutSession(assetId: string): void {
	sessions.delete(assetId);
	if (typeof localStorage !== "undefined") {
		try {
			localStorage.removeItem(LS_PREFIX + assetId);
		} catch {
			/* ignore */
		}
	}
}
