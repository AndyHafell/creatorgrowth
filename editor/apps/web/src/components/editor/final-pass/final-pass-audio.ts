import { decodeMediaAssetForAnalysis } from "@/lib/media/audio";
import type { MediaAsset } from "@/lib/media/types";

// Audio decode for Final Pass — the SAME mediabunny path Raw Cut uses
// successfully, just with a short retry. Right after a project opens, the
// asset's File can briefly not be ready, so a single early decode returns null
// ("no audio track") — which is the failure that bit Final Pass while Raw Cut,
// opened a moment later, decoded fine. Retrying a few times rides out that gap.
//
// NOTE: we deliberately do NOT fall back to AudioContext.decodeAudioData here —
// on a long clip (e.g. a 30-minute video) it decodes the whole file into PCM at
// once and can OOM/crash the tab. mediabunny streams in chunks, so it's safe.

// Linear-interpolation resample of a mono Float32 track between sample rates.
// Used to feed Whisper (16k) from the already-decoded waveform buffer (8k) so we
// don't pay for — and risk failing — a second full-file decode on long clips.
export function resampleMono(
	input: Float32Array,
	fromRate: number,
	toRate: number,
): Float32Array {
	if (fromRate === toRate || input.length === 0) return input;
	const ratio = fromRate / toRate;
	const outLen = Math.max(1, Math.floor(input.length / ratio));
	const out = new Float32Array(outLen);
	const last = input.length - 1;
	for (let i = 0; i < outLen; i++) {
		const srcIdx = i * ratio;
		const lo = Math.floor(srcIdx);
		const hi = lo + 1 > last ? last : lo + 1;
		const frac = srcIdx - lo;
		out[i] = input[lo] * (1 - frac) + input[hi] * frac;
	}
	return out;
}

// Encode a mono Float32 track to a 16-bit PCM WAV Blob — the upload format for
// cloud transcription (ElevenLabs Scribe). Small enough at 16 kHz mono (~57 MB
// for a 30-min clip) and universally accepted; we build it from the same decoded
// samples the in-browser path uses, so there's no second decode.
export function encodeWav(samples: Float32Array, sampleRate: number): Blob {
	const numSamples = samples.length;
	const buffer = new ArrayBuffer(44 + numSamples * 2);
	const view = new DataView(buffer);
	const writeStr = (offset: number, s: string) => {
		for (let i = 0; i < s.length; i++)
			view.setUint8(offset + i, s.charCodeAt(i));
	};
	writeStr(0, "RIFF");
	view.setUint32(4, 36 + numSamples * 2, true);
	writeStr(8, "WAVE");
	writeStr(12, "fmt ");
	view.setUint32(16, 16, true); // PCM chunk size
	view.setUint16(20, 1, true); // audio format = PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true); // byte rate
	view.setUint16(32, 2, true); // block align
	view.setUint16(34, 16, true); // bits per sample
	writeStr(36, "data");
	view.setUint32(40, numSamples * 2, true);
	let offset = 44;
	for (let i = 0; i < numSamples; i++) {
		const s = Math.max(-1, Math.min(1, samples[i]));
		view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
		offset += 2;
	}
	return new Blob([buffer], { type: "audio/wav" });
}

// --- Cut-boundary snapping -------------------------------------------------
// The AI's cut times (from Whisper segment timestamps) routinely land a beat
// off — often right on a waveform PEAK, slicing through a word. We never want to
// cut on a peak; a clean cut sits in the quiet gap between words/sentences. So
// we build a coarse RMS envelope of the decoded audio and snap each boundary to
// the quietest instant within a small window. Model-independent: it fixes the
// boundary regardless of how accurate the transcription timestamps were.

export interface RmsEnvelope {
	rms: Float32Array;
	hopSec: number; // seconds represented by each envelope bin
}

// One RMS value per ~binMs of mono audio. ~10ms bins give ms-level snap
// resolution; building it over a 30-min 8k buffer is a single linear pass.
export function buildRmsEnvelope(buffer: AudioBuffer, binMs = 10): RmsEnvelope {
	const data = buffer.getChannelData(0);
	const sr = buffer.sampleRate;
	const hop = Math.max(1, Math.floor((binMs / 1000) * sr));
	const n = Math.max(1, Math.ceil(data.length / hop));
	const rms = new Float32Array(n);
	for (let b = 0; b < n; b++) {
		const start = b * hop;
		const end = Math.min(data.length, start + hop);
		let sum = 0;
		for (let i = start; i < end; i++) sum += data[i] * data[i];
		rms[b] = Math.sqrt(sum / Math.max(1, end - start));
	}
	return { rms, hopSec: hop / sr };
}

// Snap a boundary time (seconds, in the envelope's timebase) to the quietest
// instant within ±windowSec. Returns the original time if the envelope is empty.
export function snapToQuietest(
	env: RmsEnvelope,
	sec: number,
	windowSec = 0.3,
): number {
	if (env.rms.length === 0 || env.hopSec <= 0) return sec;
	const center = Math.round(sec / env.hopSec);
	const span = Math.max(1, Math.round(windowSec / env.hopSec));
	const lo = Math.max(0, center - span);
	const hi = Math.min(env.rms.length - 1, center + span);
	let bestIdx = Math.min(Math.max(center, lo), hi);
	let bestVal = Number.POSITIVE_INFINITY;
	for (let i = lo; i <= hi; i++) {
		if (env.rms[i] < bestVal) {
			bestVal = env.rms[i];
			bestIdx = i;
		}
	}
	return bestIdx * env.hopSec;
}

export async function decodeFinalPassAudio({
	asset,
	targetSampleRate = 8000,
	onProgress,
}: {
	asset: MediaAsset;
	targetSampleRate?: number;
	onProgress?: (fraction: number) => void;
}): Promise<AudioBuffer | null> {
	const MAX_ATTEMPTS = 5;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		const buf = await decodeMediaAssetForAnalysis({
			asset,
			targetSampleRate,
			onProgress,
		});
		if (buf) return buf;
		// Back off briefly and try again — the File may still be hydrating.
		if (attempt < MAX_ATTEMPTS - 1) {
			await new Promise((r) => setTimeout(r, 600));
		}
	}
	return null;
}
