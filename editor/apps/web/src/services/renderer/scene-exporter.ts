import EventEmitter from "eventemitter3";

import {
	Output,
	Mp4OutputFormat,
	WebMOutputFormat,
	BufferTarget,
	StreamTarget,
	type StreamTargetChunk,
	CanvasSource,
	AudioBufferSource,
	QUALITY_LOW,
	QUALITY_MEDIUM,
	QUALITY_HIGH,
	QUALITY_VERY_HIGH,
} from "mediabunny";
import type { FrameRate } from "opencut-wasm";
import { mediaTimeToSeconds } from "opencut-wasm";
import { TICKS_PER_SECOND } from "@/lib/wasm";
import { frameRateToFloat } from "@/lib/fps/utils";
import type { RootNode } from "./nodes/root-node";
import type { ExportFormat, ExportQuality } from "@/lib/export";
import { CanvasRenderer } from "./canvas-renderer";

type ExportParams = {
	width: number;
	height: number;
	fps: FrameRate;
	format: ExportFormat;
	quality: ExportQuality;
	shouldIncludeAudio?: boolean;
	audioBuffer?: AudioBuffer;
};

const qualityMap = {
	low: QUALITY_LOW,
	medium: QUALITY_MEDIUM,
	high: QUALITY_HIGH,
	very_high: QUALITY_VERY_HIGH,
};

export type SceneExporterEvents = {
	progress: [progress: number];
	complete: [blob: Blob];
	error: [error: Error];
	cancelled: [];
};

export class SceneExporter extends EventEmitter<SceneExporterEvents> {
	private renderer: CanvasRenderer;
	private format: ExportFormat;
	private quality: ExportQuality;
	private shouldIncludeAudio: boolean;
	private audioBuffer?: AudioBuffer;

	private isCancelled = false;

	constructor({
		width,
		height,
		fps,
		format,
		quality,
		shouldIncludeAudio,
		audioBuffer,
	}: ExportParams) {
		super();
		this.renderer = new CanvasRenderer({
			width,
			height,
			fps,
		});

		this.format = format;
		this.quality = quality;
		this.shouldIncludeAudio = shouldIncludeAudio ?? false;
		this.audioBuffer = audioBuffer;
	}

	cancel(): void {
		this.isCancelled = true;
	}

	async export({ rootNode }: { rootNode: RootNode }): Promise<Blob | null> {
		const fps = this.renderer.fps;
		const fpsFloat = frameRateToFloat(fps);
		const ticksPerFrame = Math.round(
			(TICKS_PER_SECOND * fps.denominator) / fps.numerator,
		);
		const frameCount = Math.floor(rootNode.duration / ticksPerFrame);

		// Stream the muxer output straight to an OPFS file so we never hold the
		// whole encoded video in RAM. The old BufferTarget grew a single
		// ArrayBuffer in memory (reallocating as it filled) and downloadBuffer
		// then copied it again into a Blob — a 30-min export reached multiple GB
		// and OOM-crashed the tab mid-encode (~70%). With StreamTarget → OPFS the
		// peak is a ~16 MiB write buffer regardless of length, and the result is a
		// disk-backed File that downloads without ever re-entering RAM as one
		// buffer. fastStart:false keeps the MP4 moov at the end so nothing has to
		// be buffered for a front-loaded header. Falls back to the in-RAM
		// BufferTarget only where OPFS is unavailable (short clips on old browsers).
		const opfsRoot =
			typeof navigator !== "undefined" &&
			typeof navigator.storage?.getDirectory === "function"
				? await navigator.storage.getDirectory()
				: null;

		let opfsHandle: FileSystemFileHandle | null = null;
		let opfsWritable: FileSystemWritableFileStream | null = null;
		let bufferTarget: BufferTarget | null = null;
		let target: BufferTarget | StreamTarget;

		if (opfsRoot) {
			// Remove any leftover export file from a previous (or cancelled) run.
			const stale: string[] = [];
			for await (const name of opfsRoot.keys()) {
				if (name.startsWith("__export_")) stale.push(name);
			}
			for (const name of stale) {
				try {
					await opfsRoot.removeEntry(name);
				} catch {
					/* in use or already gone — ignore */
				}
			}
			opfsHandle = await opfsRoot.getFileHandle(
				`__export_${Date.now()}.${this.format}`,
				{ create: true },
			);
			opfsWritable = await opfsHandle.createWritable();
			const writable = opfsWritable;
			target = new StreamTarget(
				new WritableStream<StreamTargetChunk>({
					async write(chunk) {
						await writable.write({
							type: "write",
							position: chunk.position,
							data: chunk.data,
						});
					},
				}),
				{ chunked: true },
			);
		} else {
			bufferTarget = new BufferTarget();
			target = bufferTarget;
		}

		const outputFormat =
			this.format === "webm"
				? new WebMOutputFormat()
				: new Mp4OutputFormat({ fastStart: opfsRoot ? false : "in-memory" });

		const output = new Output({
			format: outputFormat,
			target,
		});

		const videoSource = new CanvasSource(this.renderer.getOutputCanvas(), {
			codec: this.format === "webm" ? "vp9" : "avc",
			bitrate: qualityMap[this.quality],
		});

		output.addVideoTrack(videoSource, { frameRate: fpsFloat });

		let audioSource: AudioBufferSource | null = null;
		if (this.shouldIncludeAudio && this.audioBuffer) {
			let audioCodec: "aac" | "opus" = this.format === "webm" ? "opus" : "aac";

			if (audioCodec === "aac" && typeof AudioEncoder !== "undefined") {
				const { supported } = await AudioEncoder.isConfigSupported({
					codec: "mp4a.40.2",
					sampleRate: this.audioBuffer.sampleRate,
					numberOfChannels: this.audioBuffer.numberOfChannels,
					bitrate: 192000,
				});
				if (!supported) audioCodec = "opus";
			}

			audioSource = new AudioBufferSource({
				codec: audioCodec,
				bitrate: qualityMap[this.quality],
			});
			output.addAudioTrack(audioSource);
		}

		await output.start();

		if (audioSource && this.audioBuffer) {
			await audioSource.add(this.audioBuffer);
			audioSource.close();
		}

		for (let i = 0; i < frameCount; i++) {
			if (this.isCancelled) {
				await output.cancel();
				await opfsWritable?.close().catch(() => {});
				this.emit("cancelled");
				return null;
			}

			const timeTicks = i * ticksPerFrame;
			const timeSeconds = mediaTimeToSeconds({ time: timeTicks });
			await this.renderer.render({ node: rootNode, time: timeTicks });
			await videoSource.add(timeSeconds, 1 / fpsFloat);

			this.emit("progress", i / frameCount);
		}

		if (this.isCancelled) {
			await output.cancel();
			await opfsWritable?.close().catch(() => {});
			this.emit("cancelled");
			return null;
		}

		videoSource.close();
		await output.finalize();
		this.emit("progress", 1);

		let blob: Blob | null = null;
		if (opfsWritable && opfsHandle) {
			await opfsWritable.close();
			// Disk-backed File: createObjectURL streams it from OPFS at download
			// time, so it never re-enters RAM as one contiguous buffer.
			blob = await opfsHandle.getFile();
		} else if (bufferTarget?.buffer) {
			blob = new Blob([bufferTarget.buffer]);
		}

		if (!blob) {
			this.emit("error", new Error("Failed to export video"));
			return null;
		}

		this.emit("complete", blob);
		return blob;
	}
}
