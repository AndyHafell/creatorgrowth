import {
	pipeline,
	WhisperTextStreamer,
	type AutomaticSpeechRecognitionPipeline,
	type AutomaticSpeechRecognitionOutput,
} from "@huggingface/transformers";
import type { TranscriptionSegment } from "@/lib/transcription/types";
import {
	DEFAULT_CHUNK_LENGTH_SECONDS,
	DEFAULT_STRIDE_SECONDS,
} from "@/lib/transcription/audio";

export type WorkerMessage =
	| { type: "init"; modelId: string; preferredDevice?: "webgpu" | "wasm" }
	| {
			type: "transcribe";
			audio: Float32Array;
			language: string;
			/** When true, the worker emits `transcribe-chunk` messages as Whisper finishes each chunk. Used by Raw Cut for live double-take detection. */
			streamChunks?: boolean;
	  }
	| { type: "cancel" };

export type WorkerResponse =
	| { type: "init-progress"; progress: number }
	| { type: "init-complete"; device: "webgpu" | "wasm" }
	| { type: "init-error"; error: string }
	| { type: "transcribe-progress"; progress: number }
	| {
			/**
			 * Emitted live during transcription when streamChunks=true. Each
			 * payload is a partial segment (text + spliced-coords start/end).
			 * The caller is responsible for remapping start/end back to
			 * original timeline coords.
			 */
			type: "transcribe-chunk";
			text: string;
			start: number;
			end: number;
	  }
	| {
			type: "transcribe-complete";
			text: string;
			segments: TranscriptionSegment[];
	  }
	| { type: "transcribe-error"; error: string }
	| { type: "cancelled" };

let transcriber: AutomaticSpeechRecognitionPipeline | null = null;
let cancelled = false;
let lastReportedProgress = -1;
const fileBytes = new Map<string, { loaded: number; total: number }>();

self.onmessage = async (event: MessageEvent<WorkerMessage>) => {
	const message = event.data;

	switch (message.type) {
		case "init":
			await handleInit({
				modelId: message.modelId,
				preferredDevice: message.preferredDevice,
			});
			break;
		case "transcribe":
			await handleTranscribe({
				audio: message.audio,
				language: message.language,
				streamChunks: message.streamChunks ?? false,
			});
			break;
		case "cancel":
			cancelled = true;
			self.postMessage({ type: "cancelled" } satisfies WorkerResponse);
			break;
	}
};

/**
 * Detect WebGPU availability inside the worker context. Transformers.js will
 * also try to validate, but checking up-front lets us emit a clean fallback
 * path instead of an error.
 */
function workerSupportsWebGPU(): boolean {
	try {
		// @ts-expect-error - WebGPU types may not be in lib.dom.d.ts in all setups
		return typeof navigator !== "undefined" && !!navigator.gpu;
	} catch {
		return false;
	}
}

async function handleInit({
	modelId,
	preferredDevice,
}: {
	modelId: string;
	preferredDevice?: "webgpu" | "wasm";
}) {
	lastReportedProgress = -1;
	fileBytes.clear();

	// Prefer WebGPU if requested and available; otherwise fall back to WASM.
	// On WebGPU we use fp32 (q4 quantized doesn't work well on WebGPU encoders
	// in 3.8.x for whisper); on WASM we stick with the original q4.
	const tryWebGPU =
		(preferredDevice === undefined || preferredDevice === "webgpu") &&
		workerSupportsWebGPU();

	const attempt = async (
		device: "webgpu" | "wasm",
		dtype: "fp32" | "q4",
	): Promise<AutomaticSpeechRecognitionPipeline> => {
		return (await pipeline("automatic-speech-recognition", modelId, {
			dtype,
			device,
			progress_callback: (progressInfo: {
				status?: string;
				file?: string;
				loaded?: number;
				total?: number;
			}) => {
				const file = progressInfo.file;
				if (!file) return;

				const loaded = progressInfo.loaded ?? 0;
				const total = progressInfo.total ?? 0;

				if (progressInfo.status === "progress" && total > 0) {
					fileBytes.set(file, { loaded, total });
				} else if (progressInfo.status === "done") {
					const existing = fileBytes.get(file);
					if (existing) {
						fileBytes.set(file, {
							loaded: existing.total,
							total: existing.total,
						});
					}
				}

				let totalLoaded = 0;
				let totalSize = 0;
				for (const { loaded, total } of fileBytes.values()) {
					totalLoaded += loaded;
					totalSize += total;
				}
				if (totalSize === 0) return;

				const overallProgress = (totalLoaded / totalSize) * 100;
				const roundedProgress = Math.floor(overallProgress);
				if (roundedProgress !== lastReportedProgress) {
					lastReportedProgress = roundedProgress;
					self.postMessage({
						type: "init-progress",
						progress: roundedProgress,
					} satisfies WorkerResponse);
				}
			},
		})) as unknown as AutomaticSpeechRecognitionPipeline;
	};

	try {
		let device: "webgpu" | "wasm" = "wasm";
		if (tryWebGPU) {
			try {
				transcriber = await attempt("webgpu", "fp32");
				device = "webgpu";
			} catch (gpuErr) {
				// Reset progress state for the retry pass so the bar restarts at 0.
				lastReportedProgress = -1;
				fileBytes.clear();
				console.warn(
					"[transcription-worker] WebGPU init failed, falling back to WASM:",
					gpuErr,
				);
				transcriber = await attempt("wasm", "q4");
				device = "wasm";
			}
		} else {
			transcriber = await attempt("wasm", "q4");
		}

		self.postMessage({
			type: "init-complete",
			device,
		} satisfies WorkerResponse);
	} catch (error) {
		self.postMessage({
			type: "init-error",
			error: error instanceof Error ? error.message : "Failed to load model",
		} satisfies WorkerResponse);
	}
}

async function handleTranscribe({
	audio,
	language,
	streamChunks,
}: {
	audio: Float32Array;
	language: string;
	streamChunks: boolean;
}) {
	if (!transcriber) {
		self.postMessage({
			type: "transcribe-error",
			error: "Model not initialized",
		} satisfies WorkerResponse);
		return;
	}

	cancelled = false;

	// Build a WhisperTextStreamer that buffers tokens between chunk boundaries
	// and emits one transcribe-chunk per finalized chunk. Whisper's chunk
	// boundaries are ~30s of audio, so this also gives the UI live progress.
	let streamer: WhisperTextStreamer | undefined;
	if (streamChunks) {
		const tokenizer = (transcriber as unknown as { tokenizer: unknown })
			.tokenizer;
		let currentChunkText = "";
		let currentChunkStart: number | null = null;

		streamer = new WhisperTextStreamer(
			tokenizer as ConstructorParameters<typeof WhisperTextStreamer>[0],
			{
				callback_function: (text: string) => {
					currentChunkText += text;
				},
				on_chunk_start: (startSec: number) => {
					currentChunkText = "";
					currentChunkStart = startSec;
				},
				on_chunk_end: (endSec: number) => {
					if (currentChunkStart != null && currentChunkText.trim().length > 0) {
						self.postMessage({
							type: "transcribe-chunk",
							text: currentChunkText,
							start: currentChunkStart,
							end: endSec,
						} satisfies WorkerResponse);
					}
					currentChunkText = "";
					currentChunkStart = null;
				},
				on_finalize: () => {
					currentChunkText = "";
					currentChunkStart = null;
				},
			},
		);
	}

	try {
		const rawResult = await transcriber(audio, {
			chunk_length_s: DEFAULT_CHUNK_LENGTH_SECONDS,
			stride_length_s: DEFAULT_STRIDE_SECONDS,
			language: language === "auto" ? undefined : language,
			return_timestamps: true,
			...(streamer ? { streamer } : {}),
		});

		if (cancelled) return;

		const result: AutomaticSpeechRecognitionOutput = Array.isArray(rawResult)
			? rawResult[0]
			: rawResult;

		const segments: TranscriptionSegment[] = [];

		if (result.chunks) {
			for (const chunk of result.chunks) {
				if (chunk.timestamp && chunk.timestamp.length >= 2) {
					segments.push({
						text: chunk.text,
						start: chunk.timestamp[0] ?? 0,
						end: chunk.timestamp[1] ?? chunk.timestamp[0] ?? 0,
					});
				}
			}
		}

		self.postMessage({
			type: "transcribe-complete",
			text: result.text,
			segments,
		} satisfies WorkerResponse);
	} catch (error) {
		if (cancelled) return;
		self.postMessage({
			type: "transcribe-error",
			error: error instanceof Error ? error.message : "Transcription failed",
		} satisfies WorkerResponse);
	}
}
