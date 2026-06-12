// OPFS cache for sidecar cursor logs (Magic AutoPass v4), keyed by media
// content hash — same posture as transcript-store.ts. The "Attach cursor
// log…" menu item parses the sidecar NDJSON client-side and stores clean
// samples here; the Auto Magic run reads them back by the clip's hash. No
// entry = the run behaves exactly like v3.

import type { CursorSample } from "@/lib/magic-pass/cursor-beats";

const CACHE_DIR = "magic-cursor-logs";

interface CursorLogEntry {
	version: number;
	samples: CursorSample[];
}

function opfsAvailable(): boolean {
	return (
		typeof navigator !== "undefined" &&
		"storage" in navigator &&
		typeof navigator.storage.getDirectory === "function"
	);
}

export async function readCursorLog(
	contentHash: string,
): Promise<CursorSample[] | null> {
	if (!opfsAvailable()) return null;
	try {
		const root = await navigator.storage.getDirectory();
		const dir = await root.getDirectoryHandle(CACHE_DIR);
		const handle = await dir.getFileHandle(`${contentHash}.json`);
		const file = await handle.getFile();
		const parsed = JSON.parse(await file.text()) as CursorLogEntry;
		if (parsed.version === 1 && Array.isArray(parsed.samples)) {
			return parsed.samples;
		}
		return null;
	} catch {
		// No log for this media (or OPFS unsupported) — v3 behavior.
		return null;
	}
}

export async function writeCursorLog({
	contentHash,
	samples,
}: {
	contentHash: string;
	samples: CursorSample[];
}): Promise<void> {
	if (!opfsAvailable()) {
		throw new Error("This browser doesn't support OPFS storage.");
	}
	const root = await navigator.storage.getDirectory();
	const dir = await root.getDirectoryHandle(CACHE_DIR, { create: true });
	const handle = await dir.getFileHandle(`${contentHash}.json`, {
		create: true,
	});
	const writable = await handle.createWritable();
	const entry: CursorLogEntry = { version: 1, samples };
	await writable.write(JSON.stringify(entry));
	await writable.close();
}
