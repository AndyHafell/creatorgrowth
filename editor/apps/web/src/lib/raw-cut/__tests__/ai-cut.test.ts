import { describe, expect, it } from "bun:test";
import type { Cut } from "@/components/editor/final-pass/final-pass-cache";
import {
	APPLY_CONFIDENCE_FLOOR,
	CLOUD_MODEL_ID,
	RAWCUT_CLOUD_MODEL_ID,
	shouldApplyCut,
	transcriptCacheModelIds,
} from "../ai-cut";

const WHISPER = "onnx-community/whisper-tiny";

const C = (kind: Cut["kind"], confidence: number, span = 10): Cut => ({
	start: 100,
	end: 100 + span,
	kind,
	reason: "",
	confidence,
});

// Red-or-nothing (Andy, 2026-06-11): no blue review queue — the engine decides
// in the background. Confident cuts apply; below-floor finds are dropped.
describe("shouldApplyCut", () => {
	it("applies confident cuts of EVERY kind — taste kinds included", () => {
		expect(shouldApplyCut(C("marker", 0.95))).toBe(true);
		expect(shouldApplyCut(C("retake", 0.9))).toBe(true);
		expect(shouldApplyCut(C("fluff", 0.7))).toBe(true);
		expect(shouldApplyCut(C("tangent", 0.8))).toBe(true);
	});

	it("has no span cap — a 9-minute replaced CTA applies directly", () => {
		expect(shouldApplyCut(C("retake", 0.95, 514))).toBe(true);
	});

	it("drops cuts below the confidence floor instead of queueing them", () => {
		expect(shouldApplyCut(C("fluff", 0.5))).toBe(false);
		expect(shouldApplyCut(C("retake", APPLY_CONFIDENCE_FLOOR - 0.01))).toBe(
			false,
		);
		expect(shouldApplyCut(C("retake", APPLY_CONFIDENCE_FLOOR))).toBe(true);
	});
});

describe("transcriptCacheModelIds", () => {
	it("NEVER includes the whisper entry when an ElevenLabs key exists", () => {
		// The bug class this kills: a stale whisper-tiny cache hit fed Gemini a
		// transcript that collapsed back-to-back retakes and clipped word tails.
		expect(
			transcriptCacheModelIds({ hasElevenKey: true, whisperModelId: WHISPER }),
		).toEqual([CLOUD_MODEL_ID, RAWCUT_CLOUD_MODEL_ID]);
	});

	it("falls back to the whisper entry (last) without an ElevenLabs key", () => {
		expect(
			transcriptCacheModelIds({ hasElevenKey: false, whisperModelId: WHISPER }),
		).toEqual([CLOUD_MODEL_ID, RAWCUT_CLOUD_MODEL_ID, WHISPER]);
	});
});
