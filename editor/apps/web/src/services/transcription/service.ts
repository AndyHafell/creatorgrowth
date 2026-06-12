import type {
	TranscriptionLanguage,
	TranscriptionResult,
	TranscriptionProgress,
	TranscriptionModelId,
	TranscriptionSegment,
} from "@/lib/transcription/types";
import {
	DEFAULT_TRANSCRIPTION_MODEL,
	TRANSCRIPTION_MODELS,
} from "@/lib/transcription/models";
import type { WorkerMessage, WorkerResponse } from "./worker";

type ProgressCallback = (progress: TranscriptionProgress) => void;
type SegmentCallback = (segment: TranscriptionSegment) => void;

class TranscriptionService {
	private worker: Worker | null = null;
	private currentModelId: TranscriptionModelId | null = null;
	private isInitialized = false;
	private isInitializing = false;
	private activeDevice: "webgpu" | "wasm" | null = null;

	/**
	 * Get the device the loaded model is running on. Useful for the UI to
	 * surface "running on GPU" vs "running on CPU" status. `null` if not
	 * initialized yet.
	 */
	getActiveDevice(): "webgpu" | "wasm" | null {
		return this.activeDevice;
	}

	async transcribe({
		audioData,
		language = "auto",
		modelId = DEFAULT_TRANSCRIPTION_MODEL,
		onProgress,
		onSegment,
	}: {
		audioData: Float32Array;
		language?: TranscriptionLanguage;
		modelId?: TranscriptionModelId;
		onProgress?: ProgressCallback;
		/**
		 * When provided, the worker streams partial segments as Whisper
		 * finishes each ~30s chunk. Callers can run incremental analysis
		 * (e.g. double-take detection) without waiting for the full pass.
		 * NOTE: spliced-coords. Caller must remap to original timeline if it
		 * spliced silences out before passing audioData.
		 */
		onSegment?: SegmentCallback;
	}): Promise<TranscriptionResult> {
		await this.ensureWorker({ modelId, onProgress });

		return new Promise((resolve, reject) => {
			if (!this.worker) {
				reject(new Error("Worker not initialized"));
				return;
			}

			const handleMessage = (event: MessageEvent<WorkerResponse>) => {
				const response = event.data;

				switch (response.type) {
					case "transcribe-progress":
						onProgress?.({
							status: "transcribing",
							progress: response.progress,
							message: "Transcribing audio...",
						});
						break;

					case "transcribe-chunk":
						onSegment?.({
							text: response.text,
							start: response.start,
							end: response.end,
						});
						break;

					case "transcribe-complete":
						this.worker?.removeEventListener("message", handleMessage);
						resolve({
							text: response.text,
							segments: response.segments,
							language,
						});
						break;

					case "transcribe-error":
						this.worker?.removeEventListener("message", handleMessage);
						reject(new Error(response.error));
						break;

					case "cancelled":
						this.worker?.removeEventListener("message", handleMessage);
						reject(new Error("Transcription cancelled"));
						break;
				}
			};

			this.worker.addEventListener("message", handleMessage);

			// The worker doesn't emit per-chunk progress during transcription
			// (it awaits the whole pipeline call), so the UI would sit on
			// "loading-model 100%" silently. Flip to transcribing/0 here so
			// consumers can show "Transcribing… (elapsed Xs)" instead.
			onProgress?.({
				status: "transcribing",
				progress: 0,
				message: "Transcribing audio...",
			});

			this.worker.postMessage({
				type: "transcribe",
				audio: audioData,
				language,
				streamChunks: !!onSegment,
			} satisfies WorkerMessage);
		});
	}

	cancel() {
		this.worker?.postMessage({ type: "cancel" } satisfies WorkerMessage);
	}

	/**
	 * Boot the worker + load the model without running a transcription.
	 * Used by Raw Cut's background-prefetch so the model is hot by the
	 * time the user clicks Detect (or by the time auto-detect kicks off).
	 */
	async preload({
		modelId = DEFAULT_TRANSCRIPTION_MODEL,
		onProgress,
	}: {
		modelId?: TranscriptionModelId;
		onProgress?: ProgressCallback;
	} = {}): Promise<void> {
		await this.ensureWorker({ modelId, onProgress });
	}

	private async ensureWorker({
		modelId,
		onProgress,
	}: {
		modelId: TranscriptionModelId;
		onProgress?: ProgressCallback;
	}): Promise<void> {
		const needsNewModel = this.currentModelId !== modelId;

		if (this.worker && this.isInitialized && !needsNewModel) {
			return;
		}

		if (this.isInitializing && !needsNewModel) {
			await this.waitForInit();
			return;
		}

		this.terminate();
		this.isInitializing = true;
		this.isInitialized = false;

		const model = TRANSCRIPTION_MODELS.find((m) => m.id === modelId);
		if (!model) {
			throw new Error(`Unknown model: ${modelId}`);
		}

		this.worker = new Worker(new URL("./worker.ts", import.meta.url), {
			type: "module",
		});

		return new Promise((resolve, reject) => {
			if (!this.worker) {
				reject(new Error("Failed to create worker"));
				return;
			}

			const handleMessage = (event: MessageEvent<WorkerResponse>) => {
				const response = event.data;

				switch (response.type) {
					case "init-progress":
						onProgress?.({
							status: "loading-model",
							progress: response.progress,
							message: `Loading ${model.name} model...`,
						});
						break;

					case "init-complete":
						this.worker?.removeEventListener("message", handleMessage);
						this.isInitialized = true;
						this.isInitializing = false;
						this.currentModelId = modelId;
						this.activeDevice = response.device;
						resolve();
						break;

					case "init-error":
						this.worker?.removeEventListener("message", handleMessage);
						this.isInitializing = false;
						this.terminate();
						reject(new Error(response.error));
						break;
				}
			};

			this.worker.addEventListener("message", handleMessage);

			// Default to WebGPU; the worker auto-falls-back to WASM if init or
			// device probe fails. Anything not specifying device explicitly
			// should still get the GPU path on supporting browsers.
			this.worker.postMessage({
				type: "init",
				modelId: model.huggingFaceId,
				preferredDevice: "webgpu",
			} satisfies WorkerMessage);
		});
	}

	private waitForInit(): Promise<void> {
		return new Promise((resolve) => {
			const checkInit = () => {
				if (this.isInitialized) {
					resolve();
				} else if (!this.isInitializing) {
					resolve();
				} else {
					setTimeout(checkInit, 100);
				}
			};
			checkInit();
		});
	}

	terminate() {
		this.worker?.terminate();
		this.worker = null;
		this.isInitialized = false;
		this.isInitializing = false;
		this.currentModelId = null;
		this.activeDevice = null;
	}
}

export const transcriptionService = new TranscriptionService();
