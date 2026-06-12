import type { TranscriptionSegment } from "@/lib/transcription/types";
import type { TranscriptWord } from "@/lib/raw-cut/word-snap";

/**
 * OPFS-backed cache for Raw Cut transcription output. Keyed by SHA-256 of
 * the asset's file contents — same clip → instant restore on re-open. The
 * key intentionally doesn't include silence-detection params: transcription
 * runs on the green (keep) regions, but the *text* of those regions is a
 * function of the audio, not the knobs. Worst case a stale cache returns
 * slightly more/fewer segments than a fresh pass would; we re-run double-take
 * detection over the cached segments either way.
 */

const CACHE_DIR = "raw-cut-transcriptions";

export interface CachedTranscription {
	/** Schema version. Bump if we change the JSON shape. */
	version: 1;
	/** SHA-256 hex of the source file (for self-verification). */
	contentHash: string;
	/** Model that produced these segments. */
	modelId: string;
	/** Segments in ORIGINAL timeline coords. */
	segments: TranscriptionSegment[];
	/** Word-level timings (ORIGINAL coords) — Scribe only; whisper entries and
	 *  pre-words cache entries lack them (callers fall back to RMS snapping). */
	words?: TranscriptWord[];
	/** Full concatenated text (debug). */
	text: string;
	/** Timestamp of write. */
	createdAt: number;
}

// Content fingerprint for the cache key. MUST stay constant-memory: a 30-min
// video's File is multiple GB, and the old `await file.arrayBuffer()` +
// `crypto.subtle.digest` (which can't stream and copies internally) peaked at
// ~2x the file size — ~19 GB on a long clip, which OOM-crashed the whole
// machine the instant Transcribe was clicked. Instead we hash the byte size
// plus three sampled 1 MiB windows (head/middle/tail). Stays content-addressed
// (same bytes → same key, like the old full-file hash — NOT file name/mtime,
// which would miss on re-import) but never holds more than ~3 MiB. Small files
// are still hashed whole. This is not a security hash; a collision would need
// two clips of identical size AND identical head/mid/tail MiB — and even then
// the worst case is a stale transcript, which the cache already tolerates.
//
// NOTE: changing the fingerprint invalidates existing cache entries, so the
// first Transcribe per clip after this ships re-runs once — cache misses are
// already handled gracefully (final-pass-surface.tsx).
const FINGERPRINT_WINDOW = 1 << 20; // 1 MiB

export async function computeFileHash(file: File | Blob): Promise<string> {
	const size = file.size;
	const meta = new TextEncoder().encode(`${size}`);

	const slices: Blob[] =
		size <= FINGERPRINT_WINDOW * 3
			? [file]
			: [
					file.slice(0, FINGERPRINT_WINDOW),
					file.slice(
						Math.floor(size / 2 - FINGERPRINT_WINDOW / 2),
						Math.floor(size / 2 + FINGERPRINT_WINDOW / 2),
					),
					file.slice(size - FINGERPRINT_WINDOW),
				];
	const windows = await Promise.all(slices.map((s) => s.arrayBuffer()));

	const total = meta.byteLength + windows.reduce((n, w) => n + w.byteLength, 0);
	const joined = new Uint8Array(total);
	let offset = 0;
	joined.set(meta, offset);
	offset += meta.byteLength;
	for (const w of windows) {
		joined.set(new Uint8Array(w), offset);
		offset += w.byteLength;
	}

	const digest = await crypto.subtle.digest("SHA-256", joined);
	return bufferToHex(digest);
}

function bufferToHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let hex = "";
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, "0");
	}
	return hex;
}

function isOPFSSupported(): boolean {
	return (
		typeof navigator !== "undefined" &&
		"storage" in navigator &&
		typeof navigator.storage.getDirectory === "function"
	);
}

async function getCacheDir(): Promise<FileSystemDirectoryHandle | null> {
	if (!isOPFSSupported()) return null;
	try {
		const root = await navigator.storage.getDirectory();
		return await root.getDirectoryHandle(CACHE_DIR, { create: true });
	} catch {
		return null;
	}
}

function cacheKeyFor({ hash, modelId }: { hash: string; modelId: string }) {
	// Sanitize modelId for filename use.
	const safeModel = modelId.replace(/[^A-Za-z0-9_-]/g, "_");
	return `${hash}__${safeModel}.json`;
}

export async function readCachedTranscription({
	contentHash,
	modelId,
}: {
	contentHash: string;
	modelId: string;
}): Promise<CachedTranscription | null> {
	const dir = await getCacheDir();
	if (!dir) return null;
	const key = cacheKeyFor({ hash: contentHash, modelId });
	try {
		const handle = await dir.getFileHandle(key);
		const file = await handle.getFile();
		const text = await file.text();
		const parsed = JSON.parse(text) as CachedTranscription;
		if (parsed.version !== 1) return null;
		if (parsed.contentHash !== contentHash) return null;
		return parsed;
	} catch (err) {
		if ((err as Error).name === "NotFoundError") return null;
		// Don't surface cache read errors — just miss and continue.
		console.warn("[transcription-cache] read failed:", err);
		return null;
	}
}

export async function writeCachedTranscription({
	cache,
}: {
	cache: CachedTranscription;
}): Promise<void> {
	const dir = await getCacheDir();
	if (!dir) return;
	const key = cacheKeyFor({ hash: cache.contentHash, modelId: cache.modelId });
	try {
		const handle = await dir.getFileHandle(key, { create: true });
		const writable = await handle.createWritable();
		await writable.write(JSON.stringify(cache));
		await writable.close();
	} catch (err) {
		console.warn("[transcription-cache] write failed:", err);
	}
}
