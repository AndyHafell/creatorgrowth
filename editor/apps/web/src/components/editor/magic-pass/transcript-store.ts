// Reads EVERY cached Raw Cut transcription from OPFS, regardless of which
// model produced it — Scribe, the -rawcut variant, or a dynamic whisper HF id.
// The per-(hash, model) lookup in lib/raw-cut/transcription-cache.ts can't
// enumerate, and raw-cut files are another agent's lane today, so the dir
// name is mirrored here (CACHE_DIR in transcription-cache.ts).

import type { TranscriptEntry } from "@/lib/magic-pass/pick-transcript";

const CACHE_DIR = "raw-cut-transcriptions";

export async function readAllCachedTranscriptions(): Promise<
	TranscriptEntry[]
> {
	if (
		typeof navigator === "undefined" ||
		!("storage" in navigator) ||
		typeof navigator.storage.getDirectory !== "function"
	) {
		return [];
	}
	try {
		const root = await navigator.storage.getDirectory();
		const dir = await root.getDirectoryHandle(CACHE_DIR);
		const out: TranscriptEntry[] = [];
		for await (const name of dir.keys()) {
			if (!name.endsWith(".json")) continue;
			try {
				const handle = await dir.getFileHandle(name);
				const file = await handle.getFile();
				const parsed = JSON.parse(await file.text()) as TranscriptEntry & {
					version?: number;
				};
				if (parsed.version === 1 && Array.isArray(parsed.segments)) {
					out.push(parsed);
				}
			} catch {
				// Unreadable entry — skip it, the rest of the cache still counts.
			}
		}
		return out;
	} catch {
		// No cache dir yet or OPFS unsupported.
		return [];
	}
}
