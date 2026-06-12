import type {
	AudioElement,
	VideoElement,
	LibraryAudioElement,
	RetimeConfig,
	SceneTracks,
} from "@/lib/timeline";
import { shouldMaintainPitch } from "@/lib/retime/rate";
import type { MediaAsset } from "@/lib/media/types";
import { applyAudioMasteringToBuffer } from "@/lib/media/audio-mastering";
import type { AudioCapableElement } from "@/lib/timeline/audio-state";
import {
	hasAnimatedVolume,
	resolveEffectiveAudioGain,
} from "@/lib/timeline/audio-state";
import { doesElementHaveEnabledAudio } from "@/lib/timeline/audio-separation";
import { canElementHaveAudio, hasMediaId } from "@/lib/timeline/element-utils";
import { canTrackHaveAudio } from "@/lib/timeline";
import { mediaSupportsAudio } from "@/lib/media/media-utils";
import { getSourceTimeAtClipTime, renderRetimedBuffer } from "@/lib/retime";
import { Input, ALL_FORMATS, BlobSource, AudioBufferSink } from "mediabunny";
import { TICKS_PER_SECOND } from "@/lib/wasm";

const MAX_AUDIO_CHANNELS = 2;
const EXPORT_SAMPLE_RATE = 44100;

export interface CollectedAudioElement {
	timelineElement: AudioCapableElement;
	buffer: AudioBuffer;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	muted: boolean;
	retime?: RetimeConfig;
}

export function createAudioContext({
	sampleRate,
}: {
	sampleRate?: number;
} = {}): AudioContext {
	const AudioContextConstructor =
		window.AudioContext ||
		(window as typeof window & { webkitAudioContext?: typeof AudioContext })
			.webkitAudioContext;

	return new AudioContextConstructor(sampleRate ? { sampleRate } : undefined);
}

export interface DecodedAudio {
	samples: Float32Array;
	sampleRate: number;
}

export async function decodeAudioToFloat32({
	audioBlob,
	sampleRate,
}: {
	audioBlob: Blob;
	sampleRate?: number;
}): Promise<DecodedAudio> {
	const audioContext = createAudioContext({ sampleRate });
	const arrayBuffer = await audioBlob.arrayBuffer();
	const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

	// mix down to mono
	const numChannels = audioBuffer.numberOfChannels;
	const length = audioBuffer.length;
	const samples = new Float32Array(length);

	for (let i = 0; i < length; i++) {
		let sum = 0;
		for (let channel = 0; channel < numChannels; channel++) {
			sum += audioBuffer.getChannelData(channel)[i];
		}
		samples[i] = sum / numChannels;
	}

	return { samples, sampleRate: audioBuffer.sampleRate };
}

export interface AudibleElementCandidate {
	element: AudioElement | VideoElement;
	mediaAsset: MediaAsset | null;
}

export function collectAudibleCandidates({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): AudibleElementCandidate[] {
	const allTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const mediaMap = new Map(mediaAssets.map((a) => [a.id, a]));
	const candidates: AudibleElementCandidate[] = [];

	for (const track of allTracks) {
		if (canTrackHaveAudio(track) && track.muted) continue;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;
			if (element.duration <= 0) continue;

			const mediaAsset = hasMediaId(element)
				? (mediaMap.get(element.mediaId) ?? null)
				: null;
			if (!doesElementHaveEnabledAudio({ element, mediaAsset })) continue;

			candidates.push({ element, mediaAsset });
		}
	}

	return candidates;
}

export function timelineHasAudio({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): boolean {
	return collectAudibleCandidates({ tracks, mediaAssets }).some(
		({ element }) => element.muted !== true,
	);
}

export async function collectAudioElements({
	tracks,
	mediaAssets,
	audioContext,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	audioContext: AudioContext;
}): Promise<CollectedAudioElement[]> {
	const candidates = collectAudibleCandidates({ tracks, mediaAssets });
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((media) => [media.id, media]),
	);
	const pendingElements: Array<Promise<CollectedAudioElement | null>> = [];

	// Decode each source's audio AT MOST ONCE. "Send to editor" makes many paired
	// audio clips that all reference the same video; decoding the whole track
	// per-clip is O(clips × whole-file) and hangs the export at the audio phase.
	// Keyed by asset id; shared by both the audio-element and video-element paths.
	const videoAudioCache = new Map<string, Promise<AudioBuffer | null>>();
	const decodeVideoAudio = (
		mediaAsset: MediaAsset,
	): Promise<AudioBuffer | null> => {
		let pending = videoAudioCache.get(mediaAsset.id);
		if (!pending) {
			pending = resolveAudioBufferForVideoElement({ mediaAsset, audioContext });
			videoAudioCache.set(mediaAsset.id, pending);
		}
		return pending;
	};

	for (const { element, mediaAsset } of candidates) {
		if (element.type === "audio") {
			pendingElements.push(
				resolveAudioBufferForElement({
					element,
					mediaMap,
					audioContext,
					decodeVideoAudio,
				}).then((audioBuffer) => {
					if (!audioBuffer) return null;
					return {
						timelineElement: element,
						buffer: audioBuffer,
						startTime: element.startTime / TICKS_PER_SECOND,
						duration: element.duration / TICKS_PER_SECOND,
						trimStart: element.trimStart / TICKS_PER_SECOND,
						trimEnd: element.trimEnd / TICKS_PER_SECOND,
						volume: resolveEffectiveAudioGain({
							element,
							trackMuted: false,
							localTime: 0,
						}),
						muted: element.muted === true,
						retime: element.retime,
					};
				}),
			);
			continue;
		}

		if (element.type === "video") {
			if (!mediaAsset || !mediaSupportsAudio({ media: mediaAsset })) continue;

			pendingElements.push(
				decodeVideoAudio(mediaAsset).then((audioBuffer) => {
					if (!audioBuffer) return null;
					return {
						timelineElement: element,
						buffer: audioBuffer,
						startTime: element.startTime / TICKS_PER_SECOND,
						duration: element.duration / TICKS_PER_SECOND,
						trimStart: element.trimStart / TICKS_PER_SECOND,
						trimEnd: element.trimEnd / TICKS_PER_SECOND,
						volume: resolveEffectiveAudioGain({
							element,
							trackMuted: false,
							localTime: 0,
						}),
						muted: element.muted ?? false,
						retime: element.retime,
					};
				}),
			);
		}
	}

	const resolvedElements = await Promise.all(pendingElements);
	const audioElements: CollectedAudioElement[] = [];
	for (const element of resolvedElements) {
		if (element) audioElements.push(element);
	}
	return audioElements;
}

async function resolveAudioBufferForElement({
	element,
	mediaMap,
	audioContext,
	decodeVideoAudio,
}: {
	element: AudioElement;
	mediaMap: Map<string, MediaAsset>;
	audioContext: AudioContext;
	decodeVideoAudio: (mediaAsset: MediaAsset) => Promise<AudioBuffer | null>;
}): Promise<AudioBuffer | null> {
	try {
		if (element.sourceType === "upload") {
			const asset = mediaMap.get(element.mediaId);
			if (!asset) return null;
			// Raw Cut / Final Pass "Send to editor" pairs each kept VIDEO clip with
			// an audio element that references the SAME (video) media. Pull the
			// audio out of the video container via mediabunny (streams, memory-safe),
			// decoded once per source via the shared cache. The old code rejected
			// any non-"audio" asset here, so these paired clips were silent.
			if (asset.type === "video") {
				return await decodeVideoAudio(asset);
			}
			if (asset.type !== "audio") return null;

			const arrayBuffer = await asset.file.arrayBuffer();
			return await audioContext.decodeAudioData(arrayBuffer.slice(0));
		}

		if (element.buffer) return element.buffer;

		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const arrayBuffer = await response.arrayBuffer();
		return await audioContext.decodeAudioData(arrayBuffer.slice(0));
	} catch (error) {
		console.warn("Failed to decode audio:", error);
		return null;
	}
}

async function resolveAudioBufferForVideoElement({
	mediaAsset,
	audioContext,
}: {
	mediaAsset: MediaAsset;
	audioContext: AudioContext;
}): Promise<AudioBuffer | null> {
	const input = new Input({
		source: new BlobSource(mediaAsset.file),
		formats: ALL_FORMATS,
	});

	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) return null;

		const sink = new AudioBufferSink(audioTrack);
		const targetSampleRate = audioContext.sampleRate;

		const chunks: AudioBuffer[] = [];
		let totalSamples = 0;

		for await (const { buffer } of sink.buffers(0)) {
			chunks.push(buffer);
			totalSamples += buffer.length;
		}

		if (chunks.length === 0) return null;

		const nativeSampleRate = chunks[0].sampleRate;
		const numChannels = Math.min(
			MAX_AUDIO_CHANNELS,
			chunks[0].numberOfChannels,
		);

		const nativeChannels = Array.from(
			{ length: numChannels },
			() => new Float32Array(totalSamples),
		);
		let offset = 0;
		for (const chunk of chunks) {
			for (let channel = 0; channel < numChannels; channel++) {
				const sourceData = chunk.getChannelData(
					Math.min(channel, chunk.numberOfChannels - 1),
				);
				nativeChannels[channel].set(sourceData, offset);
			}
			offset += chunk.length;
		}

		// use OfflineAudioContext for high-quality resampling to target rate
		const outputSamples = Math.ceil(
			totalSamples * (targetSampleRate / nativeSampleRate),
		);
		const offlineContext = new OfflineAudioContext(
			numChannels,
			outputSamples,
			targetSampleRate,
		);

		const nativeBuffer = audioContext.createBuffer(
			numChannels,
			totalSamples,
			nativeSampleRate,
		);
		for (let ch = 0; ch < numChannels; ch++) {
			nativeBuffer.copyToChannel(nativeChannels[ch], ch);
		}

		const sourceNode = offlineContext.createBufferSource();
		sourceNode.buffer = nativeBuffer;
		sourceNode.connect(offlineContext.destination);
		sourceNode.start(0);

		return await offlineContext.startRendering();
	} catch (error) {
		console.warn("Failed to decode video audio:", error);
		return null;
	} finally {
		input.dispose();
	}
}

interface AudioMixSource {
	timelineElement: AudioCapableElement;
	file: File;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	retime?: RetimeConfig;
}

export interface AudioClipSource {
	timelineElement: AudioCapableElement;
	id: string;
	sourceKey: string;
	file: File;
	startTime: number;
	duration: number;
	trimStart: number;
	trimEnd: number;
	volume: number;
	muted: boolean;
	retime?: RetimeConfig;
}

async function fetchLibraryAudioSource({
	element,
	volume,
}: {
	element: LibraryAudioElement;
	volume: number;
}): Promise<AudioMixSource | null> {
	try {
		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		const file = new File([blob], `${element.name}.mp3`, {
			type: "audio/mpeg",
		});

		return {
			timelineElement: element,
			file,
			startTime: element.startTime / TICKS_PER_SECOND,
			duration: element.duration / TICKS_PER_SECOND,
			trimStart: element.trimStart / TICKS_PER_SECOND,
			trimEnd: element.trimEnd / TICKS_PER_SECOND,
			volume,
			retime: element.retime,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

async function fetchLibraryAudioClip({
	element,
	muted,
	volume,
}: {
	element: LibraryAudioElement;
	muted: boolean;
	volume: number;
}): Promise<AudioClipSource | null> {
	try {
		const response = await fetch(element.sourceUrl);
		if (!response.ok) {
			throw new Error(`Library audio fetch failed: ${response.status}`);
		}

		const blob = await response.blob();
		const file = new File([blob], `${element.name}.mp3`, {
			type: "audio/mpeg",
		});

		return {
			timelineElement: element,
			id: element.id,
			sourceKey: element.id,
			file,
			startTime: element.startTime,
			duration: element.duration,
			trimStart: element.trimStart,
			trimEnd: element.trimEnd,
			volume,
			muted,
			retime: element.retime,
		};
	} catch (error) {
		console.warn("Failed to fetch library audio:", error);
		return null;
	}
}

function collectMediaAudioSource({
	element,
	mediaAsset,
	volume,
}: {
	element: AudioCapableElement;
	mediaAsset: MediaAsset;
	volume: number;
}): AudioMixSource {
	return {
		timelineElement: element,
		file: mediaAsset.file,
		startTime: element.startTime / TICKS_PER_SECOND,
		duration: element.duration / TICKS_PER_SECOND,
		trimStart: element.trimStart / TICKS_PER_SECOND,
		trimEnd: element.trimEnd / TICKS_PER_SECOND,
		volume,
		retime: element.retime,
	};
}

function collectMediaAudioClip({
	element,
	mediaAsset,
	muted,
	volume,
}: {
	element: AudioCapableElement;
	mediaAsset: MediaAsset;
	muted: boolean;
	volume: number;
}): AudioClipSource {
	return {
		timelineElement: element,
		id: element.id,
		sourceKey: mediaAsset.id,
		file: mediaAsset.file,
		startTime: element.startTime / TICKS_PER_SECOND,
		duration: element.duration / TICKS_PER_SECOND,
		trimStart: element.trimStart / TICKS_PER_SECOND,
		trimEnd: element.trimEnd / TICKS_PER_SECOND,
		volume,
		muted,
		retime: element.retime,
	};
}

export async function collectAudioMixSources({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): Promise<AudioMixSource[]> {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const audioMixSources: AudioMixSource[] = [];
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	const pendingLibrarySources: Array<Promise<AudioMixSource | null>> = [];

	for (const track of orderedTracks) {
		if (canTrackHaveAudio(track) && track.muted) continue;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;
			if (element.muted === true) continue;
			const mediaAsset = hasMediaId(element)
				? (mediaMap.get(element.mediaId) ?? null)
				: null;
			if (!doesElementHaveEnabledAudio({ element, mediaAsset })) continue;
			const volume = resolveEffectiveAudioGain({
				element,
				localTime: 0,
			});

			if (element.type === "audio") {
				if (element.sourceType === "upload") {
					const mediaAsset = mediaMap.get(element.mediaId);
					if (!mediaAsset) continue;

					audioMixSources.push(
						collectMediaAudioSource({ element, mediaAsset, volume }),
					);
				} else {
					pendingLibrarySources.push(
						fetchLibraryAudioSource({ element, volume }),
					);
				}
				continue;
			}

			if (element.type === "video") {
				if (mediaAsset && mediaSupportsAudio({ media: mediaAsset })) {
					audioMixSources.push(
						collectMediaAudioSource({ element, mediaAsset, volume }),
					);
				}
			}
		}
	}

	const resolvedLibrarySources = await Promise.all(pendingLibrarySources);
	for (const source of resolvedLibrarySources) {
		if (source) audioMixSources.push(source);
	}

	return audioMixSources;
}

export async function collectAudioClips({
	tracks,
	mediaAssets,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
}): Promise<AudioClipSource[]> {
	const orderedTracks = [...tracks.overlay, tracks.main, ...tracks.audio];
	const clips: AudioClipSource[] = [];
	const mediaMap = new Map<string, MediaAsset>(
		mediaAssets.map((asset) => [asset.id, asset]),
	);
	const pendingLibraryClips: Array<Promise<AudioClipSource | null>> = [];

	for (const track of orderedTracks) {
		const isTrackMuted = canTrackHaveAudio(track) && track.muted;

		for (const element of track.elements) {
			if (!canElementHaveAudio(element)) continue;

			const mediaAsset = hasMediaId(element)
				? (mediaMap.get(element.mediaId) ?? null)
				: null;
			if (!doesElementHaveEnabledAudio({ element, mediaAsset })) continue;

			const isElementMuted =
				"muted" in element ? (element.muted ?? false) : false;
			const muted = isTrackMuted || isElementMuted;
			const volume = resolveEffectiveAudioGain({
				element,
				trackMuted: isTrackMuted,
				localTime: 0,
			});

			if (element.type === "audio") {
				if (element.sourceType === "upload") {
					const mediaAsset = mediaMap.get(element.mediaId);
					if (!mediaAsset) continue;

					clips.push(
						collectMediaAudioClip({
							element,
							mediaAsset,
							muted,
							volume,
						}),
					);
				} else {
					pendingLibraryClips.push(
						fetchLibraryAudioClip({ element, muted, volume }),
					);
				}
				continue;
			}

			if (element.type === "video") {
				if (mediaAsset && mediaSupportsAudio({ media: mediaAsset })) {
					clips.push(
						collectMediaAudioClip({
							element,
							mediaAsset,
							muted,
							volume,
						}),
					);
				}
			}
		}
	}

	const resolvedLibraryClips = await Promise.all(pendingLibraryClips);
	for (const clip of resolvedLibraryClips) {
		if (clip) clips.push(clip);
	}

	return clips;
}

export async function createTimelineAudioBuffer({
	tracks,
	mediaAssets,
	duration,
	sampleRate = EXPORT_SAMPLE_RATE,
	audioContext,
}: {
	tracks: SceneTracks;
	mediaAssets: MediaAsset[];
	duration: number;
	sampleRate?: number;
	audioContext?: AudioContext;
}): Promise<AudioBuffer | null> {
	const context = audioContext ?? createAudioContext({ sampleRate });

	const audioElements = await collectAudioElements({
		tracks,
		mediaAssets,
		audioContext: context,
	});

	if (audioElements.length === 0) return null;

	const outputChannels = 2;
	const durationSeconds = duration / TICKS_PER_SECOND;
	const outputLength = Math.ceil(durationSeconds * sampleRate);
	const outputBuffer = context.createBuffer(
		outputChannels,
		outputLength,
		sampleRate,
	);

	for (const element of audioElements) {
		if (element.muted) continue;

		const renderedBuffer = shouldMaintainPitch({
			rate: element.retime?.rate ?? 1,
			maintainPitch: element.retime?.maintainPitch,
		})
			? await renderRetimedBuffer({
					audioContext: context,
					sourceBuffer: element.buffer,
					trimStart: element.trimStart,
					clipDuration: element.duration,
					retime: element.retime,
					maintainPitch: true,
				})
			: undefined;

		mixAudioChannels({
			element,
			buffer: renderedBuffer ?? element.buffer,
			trimStart: renderedBuffer ? 0 : element.trimStart,
			retime: renderedBuffer ? undefined : element.retime,
			outputBuffer,
			outputLength,
			sampleRate,
		});
	}

	return await applyAudioMasteringToBuffer({ audioBuffer: outputBuffer });
}

// Pure peak extraction lives in rms.ts (unit-testable without the wasm import
// this module drags in); re-exported here so existing callers are unchanged.
export { computeGlobalMaxRms, extractRmsRange } from "@/lib/media/rms";

/* ------------------------------------------------------------------------- */
/* Raw Cut: silence detection + media-asset audio decode                     */
/* ------------------------------------------------------------------------- */

export interface SilenceRange {
	startSec: number;
	endSec: number;
}

export interface SilenceDetectionParams {
	thresholdDb: number;
	minSilenceSec: number;
	ignoreShorterKeepsSec: number;
	leftPadSec: number;
	rightPadSec: number;
	windowMs?: number;
}

export const DEFAULT_SILENCE_PARAMS: SilenceDetectionParams = {
	thresholdDb: -39,
	minSilenceSec: 1,
	ignoreShorterKeepsSec: 1,
	leftPadSec: 0.01,
	rightPadSec: 0.15,
	windowMs: 20,
};

/**
 * RMS dB-threshold silence detection over a decoded AudioBuffer. Returns
 * non-overlapping silence intervals (the complement = "keep" regions).
 *
 * - thresholdDb: window RMS below this → silent
 * - minSilenceSec: drop silences shorter than this (they stay as keeps)
 * - leftPad/rightPad: shrink each kept silence inward so the surrounding
 *   keep regions extend earlier/later, matching the TimeBolt knobs
 * - ignoreShorterKeepsSec: if the gap between two silences is shorter than
 *   this, merge them — the tiny keep gets absorbed into the silence
 */
export function computeSilenceRanges({
	buffer,
	params = DEFAULT_SILENCE_PARAMS,
}: {
	buffer: AudioBuffer;
	params?: SilenceDetectionParams;
}): SilenceRange[] {
	const {
		thresholdDb,
		minSilenceSec,
		ignoreShorterKeepsSec,
		leftPadSec,
		rightPadSec,
		windowMs = 20,
	} = params;

	const sampleRate = buffer.sampleRate;
	const totalSamples = buffer.length;
	const channels = buffer.numberOfChannels;
	const windowSize = Math.max(1, Math.floor((windowMs / 1000) * sampleRate));
	const thresholdLin = 10 ** (thresholdDb / 20);
	const windowsCount = Math.ceil(totalSamples / windowSize);

	// Per-window: sum-of-squares across all channels, then mean → RMS.
	const sumSq = new Float64Array(windowsCount);
	const counts = new Int32Array(windowsCount);

	for (let c = 0; c < channels; c++) {
		const data = buffer.getChannelData(c);
		for (let w = 0; w < windowsCount; w++) {
			const start = w * windowSize;
			const end = Math.min(start + windowSize, totalSamples);
			let s = 0;
			for (let i = start; i < end; i++) s += data[i] * data[i];
			sumSq[w] += s;
			if (c === 0) counts[w] = end - start;
		}
	}

	const isSilent = new Uint8Array(windowsCount);
	for (let w = 0; w < windowsCount; w++) {
		const n = counts[w] * channels;
		const rms = n > 0 ? Math.sqrt(sumSq[w] / n) : 0;
		isSilent[w] = rms < thresholdLin ? 1 : 0;
	}

	// Group runs of silent windows.
	const raw: SilenceRange[] = [];
	let runStart = -1;
	for (let w = 0; w < windowsCount; w++) {
		if (isSilent[w]) {
			if (runStart < 0) runStart = w;
		} else if (runStart >= 0) {
			raw.push({
				startSec: (runStart * windowSize) / sampleRate,
				endSec: (w * windowSize) / sampleRate,
			});
			runStart = -1;
		}
	}
	if (runStart >= 0) {
		raw.push({
			startSec: (runStart * windowSize) / sampleRate,
			endSec: totalSamples / sampleRate,
		});
	}

	// Keep only silences ≥ minSilenceSec, then pad inward (extending the
	// surrounding keep regions outward).
	const padded: SilenceRange[] = [];
	for (const r of raw) {
		if (r.endSec - r.startSec < minSilenceSec) continue;
		const s = r.startSec + rightPadSec;
		const e = r.endSec - leftPadSec;
		if (e > s) padded.push({ startSec: s, endSec: e });
	}

	// Merge adjacent silences whose between-gap (keep) is shorter than
	// ignoreShorterKeepsSec.
	const merged: SilenceRange[] = [];
	for (const s of padded) {
		const last = merged[merged.length - 1];
		if (last && s.startSec - last.endSec < ignoreShorterKeepsSec) {
			last.endSec = s.endSec;
		} else {
			merged.push({ startSec: s.startSec, endSec: s.endSec });
		}
	}

	return merged;
}

/**
 * Decode a MediaAsset (uploaded audio or video) into a small mono
 * AudioBuffer suitable for Raw Cut silence detection and waveform painting.
 *
 * The full-rate stereo buffer for a 2hr clip is ~2.7 GB and hangs Chrome,
 * so we stream PCM chunks from mediabunny, mono-mix + linear-interp
 * downsample each chunk inline, and never hold a native-rate buffer. Default
 * target is 8 kHz mono (~230 MB for 2hr) — plenty for RMS envelope work.
 *
 * onProgress fires as decode advances (0..1). We yield to the event loop
 * between chunks so the UI stays responsive.
 */
export async function decodeMediaAssetForAnalysis({
	asset,
	targetSampleRate = 8000,
	onProgress,
}: {
	asset: MediaAsset;
	targetSampleRate?: number;
	onProgress?: (fraction: number) => void;
}): Promise<AudioBuffer | null> {
	if (asset.type === "image") return null;

	const input = new Input({
		source: new BlobSource(asset.file),
		formats: ALL_FORMATS,
	});

	try {
		const audioTrack = await input.getPrimaryAudioTrack();
		if (!audioTrack) return null;

		const totalDurationSec =
			asset.duration && Number.isFinite(asset.duration) ? asset.duration : null;

		const sink = new AudioBufferSink(audioTrack);
		const monoChunks: Float32Array[] = [];
		let totalOutSamples = 0;
		let lastProgressEmit = 0;
		let lastYield = performance.now();

		for await (const { buffer } of sink.buffers(0)) {
			const nativeRate = buffer.sampleRate;
			const ratio = nativeRate / targetSampleRate;
			const channels = buffer.numberOfChannels;
			const outLen = Math.max(0, Math.floor(buffer.length / ratio));
			if (outLen === 0) continue;

			const mono = new Float32Array(outLen);
			// Pre-snapshot channel arrays so we don't call getChannelData per sample.
			const channelData: Float32Array[] = new Array(channels);
			for (let c = 0; c < channels; c++) {
				channelData[c] = buffer.getChannelData(c);
			}
			const lastIdx = buffer.length - 1;
			for (let i = 0; i < outLen; i++) {
				const srcIdx = i * ratio;
				const lo = Math.floor(srcIdx);
				const hi = lo + 1 > lastIdx ? lastIdx : lo + 1;
				const frac = srcIdx - lo;
				let sum = 0;
				for (let c = 0; c < channels; c++) {
					sum += channelData[c][lo] * (1 - frac) + channelData[c][hi] * frac;
				}
				mono[i] = sum / channels;
			}
			monoChunks.push(mono);
			totalOutSamples += outLen;

			// Progress + yield.
			const now = performance.now();
			if (now - lastYield > 30) {
				lastYield = now;
				if (onProgress) {
					const pct = totalDurationSec
						? Math.min(
								0.99,
								totalOutSamples / (totalDurationSec * targetSampleRate),
							)
						: 0;
					if (pct - lastProgressEmit > 0.01) {
						lastProgressEmit = pct;
						onProgress(pct);
					}
				}
				await new Promise((r) => setTimeout(r, 0));
			}
		}

		if (totalOutSamples === 0) return null;

		const full = new Float32Array(totalOutSamples);
		let off = 0;
		for (const ch of monoChunks) {
			full.set(ch, off);
			off += ch.length;
		}

		onProgress?.(1);

		// AudioContext is just a factory for AudioBuffer here; close immediately.
		const ctx = new AudioContext();
		try {
			const out = ctx.createBuffer(1, totalOutSamples, targetSampleRate);
			out.copyToChannel(full, 0);
			return out;
		} finally {
			await ctx.close();
		}
	} catch (err) {
		console.warn("[raw-cut] decode-for-analysis failed", err);
		return null;
	} finally {
		input.dispose();
	}
}

function mixAudioChannels({
	element,
	buffer,
	trimStart,
	retime,
	outputBuffer,
	outputLength,
	sampleRate,
}: {
	element: CollectedAudioElement;
	buffer: AudioBuffer;
	trimStart: number;
	retime?: RetimeConfig;
	outputBuffer: AudioBuffer;
	outputLength: number;
	sampleRate: number;
}): void {
	const { startTime, duration: elementDuration } = element;

	const outputStartSample = Math.floor(startTime * sampleRate);
	const renderedLength = Math.ceil(elementDuration * sampleRate);

	const outputChannels = 2;
	for (let channel = 0; channel < outputChannels; channel++) {
		const outputData = outputBuffer.getChannelData(channel);
		const sourceChannel = Math.min(channel, buffer.numberOfChannels - 1);
		const sourceData = buffer.getChannelData(sourceChannel);

		for (let i = 0; i < renderedLength; i++) {
			const outputIndex = outputStartSample + i;
			if (outputIndex >= outputLength) break;

			const clipTime = i / sampleRate;
			const sourceTime =
				trimStart + getSourceTimeAtClipTime({ clipTime, retime });
			const sourceIndex = sourceTime * buffer.sampleRate;
			if (sourceIndex >= sourceData.length) break;

			const lowerIndex = Math.floor(sourceIndex);
			const upperIndex = Math.min(sourceData.length - 1, lowerIndex + 1);
			const fraction = sourceIndex - lowerIndex;
			const gain = hasAnimatedVolume({ element: element.timelineElement })
				? resolveEffectiveAudioGain({
						element: element.timelineElement,
						localTime: clipTime,
					})
				: element.volume;
			outputData[outputIndex] +=
				(sourceData[lowerIndex] * (1 - fraction) +
					sourceData[upperIndex] * fraction) *
				gain;
		}
	}
}
