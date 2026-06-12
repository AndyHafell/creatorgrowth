import type { TranscriptionModel, TranscriptionModelId } from "./types";

export const TRANSCRIPTION_MODELS: TranscriptionModel[] = [
	{
		id: "whisper-tiny",
		name: "Tiny",
		huggingFaceId: "onnx-community/whisper-tiny",
		description: "Fastest, lower accuracy",
	},
	{
		id: "whisper-small",
		name: "Small",
		huggingFaceId: "onnx-community/whisper-small",
		description: "Good balance of speed and accuracy",
	},
	{
		id: "whisper-medium",
		name: "Medium",
		huggingFaceId: "onnx-community/whisper-medium",
		description: "Higher accuracy, slower",
	},
	{
		id: "whisper-large-v3-turbo",
		name: "Large v3 Turbo",
		huggingFaceId: "onnx-community/whisper-large-v3-turbo",
		description: "Best accuracy, requires WebGPU for good performance",
	},
];

/**
 * In-browser fallback model (no picker, per Andy's call). Tiny is the FAST local
 * path (~80s for a 30-min clip on GPU). It's only a fallback now: Final Pass
 * prefers cloud Whisper (Replicate/ElevenLabs, BYO key) for accuracy + speed —
 * turbo's much-better timestamps came at a 5-10 min wait, which isn't worth it
 * when a cloud call returns in well under a minute. Raw Cut still uses this.
 */
export const DEFAULT_TRANSCRIPTION_MODEL: TranscriptionModelId =
	"whisper-tiny";
