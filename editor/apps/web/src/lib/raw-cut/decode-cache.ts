/**
 * Two-tier cache for the decoded *analysis* AudioBuffer (the ~8kHz mono PCM the
 * silence detector + waveform run on). Decoding a 2hr clip costs ~20-25s, so we
 * never want to pay it twice for the same asset.
 *
 *  • Tier 1 — in-memory `Map<assetId, AudioBuffer>`. Survives the RawCutSurface
 *    unmount on an Edit↔Raw Cut mode switch (module scope outlives the
 *    component). Instant, synchronous.
 *  • Tier 2 — OPFS binary file per asset. Survives a full page reload / HMR,
 *    where the in-memory map is gone. We persist the raw PCM and rebuild the
 *    AudioBuffer with the `AudioBuffer` constructor — no AudioContext, no
 *    decode. Keyed by `asset.id`, which is stable across reloads (media lives
 *    in OPFS, ids in the IndexedDB project).
 *
 * This deliberately does NOT touch `decodeMediaAssetForAnalysis` / the decode
 * pipeline — callers check the cache first and store the result after.
 */

const CACHE_DIR = "raw-cut-analysis-buffers";
const MAGIC = 0x52435542; // "RCUB"
const VERSION = 1;
const HEADER_BYTES = 20; // magic, version, sampleRate, length, channels (5×uint32)

const MAX_MEMORY = 3;
const MAX_DISK = 2;

const memory = new Map<string, AudioBuffer>();

export function getMemoryBuffer(assetId: string): AudioBuffer | undefined {
	return memory.get(assetId);
}

function rememberInMemory(assetId: string, buffer: AudioBuffer): void {
	memory.delete(assetId);
	memory.set(assetId, buffer);
	while (memory.size > MAX_MEMORY) {
		const oldest = memory.keys().next().value;
		if (oldest === undefined) break;
		memory.delete(oldest);
	}
}

export function dropMemoryBuffer(assetId: string): void {
	memory.delete(assetId);
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

function fileNameFor(assetId: string): string {
	return `${assetId.replace(/[^A-Za-z0-9_-]/g, "_")}.pcm`;
}

/** Reconstruct an AudioBuffer from stored PCM without decoding. */
function decodeStored(bytes: ArrayBuffer): AudioBuffer | null {
	if (bytes.byteLength < HEADER_BYTES) return null;
	const header = new DataView(bytes, 0, HEADER_BYTES);
	if (header.getUint32(0) !== MAGIC) return null;
	if (header.getUint32(4) !== VERSION) return null;
	const sampleRate = header.getUint32(8);
	const length = header.getUint32(12);
	const channels = header.getUint32(16);
	if (sampleRate <= 0 || length <= 0 || channels <= 0) return null;

	const expected = HEADER_BYTES + channels * length * 4;
	if (bytes.byteLength < expected) return null;

	const buffer = new AudioBuffer({
		numberOfChannels: channels,
		length,
		sampleRate,
	});
	for (let ch = 0; ch < channels; ch++) {
		const offset = HEADER_BYTES + ch * length * 4;
		buffer.copyToChannel(new Float32Array(bytes, offset, length), ch);
	}
	return buffer;
}

async function readDiskBuffer(assetId: string): Promise<AudioBuffer | null> {
	const dir = await getCacheDir();
	if (!dir) return null;
	try {
		const handle = await dir.getFileHandle(fileNameFor(assetId));
		const file = await handle.getFile();
		const bytes = await file.arrayBuffer();
		return decodeStored(bytes);
	} catch (err) {
		if ((err as Error).name === "NotFoundError") return null;
		console.warn("[decode-cache] read failed:", err);
		return null;
	}
}

/** Best-effort eviction so OPFS doesn't grow unbounded (each entry ~230MB). */
async function evictDisk(dir: FileSystemDirectoryHandle): Promise<void> {
	try {
		const entries: Array<{ name: string; lastModified: number }> = [];
		for await (const entry of dir.values()) {
			if (entry.kind !== "file") continue;
			const file = await (entry as FileSystemFileHandle).getFile();
			entries.push({ name: entry.name, lastModified: file.lastModified });
		}
		entries.sort((a, b) => a.lastModified - b.lastModified);
		for (let i = 0; i < entries.length - MAX_DISK; i++) {
			await dir.removeEntry(entries[i].name);
		}
	} catch (err) {
		console.warn("[decode-cache] evict failed:", err);
	}
}

async function writeDiskBuffer(
	assetId: string,
	buffer: AudioBuffer,
): Promise<void> {
	const dir = await getCacheDir();
	if (!dir) return;
	try {
		const channels = buffer.numberOfChannels;
		const length = buffer.length;
		const header = new DataView(new ArrayBuffer(HEADER_BYTES));
		header.setUint32(0, MAGIC);
		header.setUint32(4, VERSION);
		header.setUint32(8, buffer.sampleRate);
		header.setUint32(12, length);
		header.setUint32(16, channels);

		const handle = await dir.getFileHandle(fileNameFor(assetId), {
			create: true,
		});
		const writable = await handle.createWritable();
		await writable.write(header.buffer);
		for (let ch = 0; ch < channels; ch++) {
			// getChannelData returns a view onto the buffer's storage; writing it
			// writes that channel's float32 bytes.
			await writable.write(buffer.getChannelData(ch));
		}
		await writable.close();
		await evictDisk(dir);
	} catch (err) {
		console.warn("[decode-cache] write failed:", err);
	}
}

/** Memory → OPFS lookup. Returns null on a miss (caller then decodes). */
export async function loadCachedAnalysisBuffer(
	assetId: string,
): Promise<AudioBuffer | null> {
	const mem = memory.get(assetId);
	if (mem) return mem;
	const disk = await readDiskBuffer(assetId);
	if (disk) {
		rememberInMemory(assetId, disk);
		return disk;
	}
	return null;
}

/** Store a freshly-decoded buffer in both tiers. */
export async function storeCachedAnalysisBuffer(
	assetId: string,
	buffer: AudioBuffer,
): Promise<void> {
	rememberInMemory(assetId, buffer);
	await writeDiskBuffer(assetId, buffer);
}
