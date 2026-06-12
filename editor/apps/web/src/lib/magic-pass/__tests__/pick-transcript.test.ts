import { describe, expect, test } from "bun:test";
import { pickTranscript, type TranscriptEntry } from "../pick-transcript";

function entry(over: Partial<TranscriptEntry> = {}): TranscriptEntry {
	return {
		contentHash: "aaa",
		modelId: "elevenlabs-scribe_v1",
		segments: [{ text: "hello world", start: 0, end: 780 }],
		createdAt: 1000,
		...over,
	};
}

describe("pickTranscript", () => {
	test("prefers an exact hash match over a more recent non-match", () => {
		const picked = pickTranscript({
			entries: [
				entry({ contentHash: "bbb", createdAt: 9000 }),
				entry({ contentHash: "aaa", createdAt: 1000 }),
			],
			contentHash: "aaa",
			mediaDurationSec: 780,
		});
		expect(picked?.contentHash).toBe("aaa");
	});

	test("among hash matches, prefers the entry with word-level timings", () => {
		const picked = pickTranscript({
			entries: [
				entry({ modelId: "whisper-x", createdAt: 9000 }),
				entry({
					modelId: "elevenlabs-scribe_v1",
					words: [{ text: "hello", start: 0, end: 0.4 }],
					createdAt: 1000,
				}),
			],
			contentHash: "aaa",
			mediaDurationSec: 780,
		});
		expect(picked?.words?.length).toBe(1);
	});

	test("no hash match: falls back to the most recent duration-compatible entry", () => {
		const picked = pickTranscript({
			entries: [
				entry({ contentHash: "old", createdAt: 1000 }),
				entry({ contentHash: "new", createdAt: 5000 }),
			],
			contentHash: "missing",
			mediaDurationSec: 800,
		});
		expect(picked?.contentHash).toBe("new");
	});

	test("no hash match: rejects entries whose span is far from the media duration", () => {
		const picked = pickTranscript({
			entries: [
				entry({
					contentHash: "short-clip",
					segments: [{ text: "hi", start: 0, end: 60 }],
				}),
			],
			contentHash: "missing",
			mediaDurationSec: 800,
		});
		expect(picked).toBeNull();
	});

	test("empty cache returns null", () => {
		const picked = pickTranscript({
			entries: [],
			contentHash: "aaa",
			mediaDurationSec: 780,
		});
		expect(picked).toBeNull();
	});
});
