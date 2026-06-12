// Offscreen frame sampler for Magic AutoPass. The editor's media lives
// client-side (OPFS File), so frames for the Gemini vision refine are grabbed
// here: one <video> element, sequential seeks, downscaled JPEG data URLs.

const TARGET_WIDTH = 640;
const JPEG_QUALITY = 0.72;
const SEEK_TIMEOUT_MS = 4000;

export interface SampledFrame {
	timeSec: number;
	dataUrl: string;
}

function once<K extends keyof HTMLVideoElementEventMap>(
	video: HTMLVideoElement,
	event: K,
	timeoutMs: number,
): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = window.setTimeout(() => {
			cleanup();
			resolve(false);
		}, timeoutMs);
		const onEvent = () => {
			cleanup();
			resolve(true);
		};
		const cleanup = () => {
			window.clearTimeout(timer);
			video.removeEventListener(event, onEvent);
		};
		video.addEventListener(event, onEvent);
	});
}

/**
 * Sample one frame per requested time. `times` are MEDIA seconds (caller maps
 * timeline → media). Failed seeks are skipped, not fatal — the refine route
 * tolerates missing frames.
 */
export async function sampleFrames({
	file,
	times,
}: {
	file: File | Blob;
	times: Array<{ timelineSec: number; mediaSec: number }>;
}): Promise<SampledFrame[]> {
	if (times.length === 0) return [];
	const url = URL.createObjectURL(file);
	const video = document.createElement("video");
	video.muted = true;
	video.preload = "auto";
	video.src = url;

	const frames: SampledFrame[] = [];
	try {
		if (video.readyState < 1) {
			const ok = await once(video, "loadedmetadata", SEEK_TIMEOUT_MS * 2);
			if (!ok) return [];
		}
		const aspect = video.videoHeight / Math.max(1, video.videoWidth);
		const canvas = document.createElement("canvas");
		canvas.width = TARGET_WIDTH;
		canvas.height = Math.max(2, Math.round(TARGET_WIDTH * aspect));
		const ctx = canvas.getContext("2d");
		if (!ctx) return [];

		for (const t of times) {
			video.currentTime = Math.max(0, t.mediaSec);
			const ok = await once(video, "seeked", SEEK_TIMEOUT_MS);
			if (!ok) continue;
			try {
				ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
				frames.push({
					timeSec: t.timelineSec,
					dataUrl: canvas.toDataURL("image/jpeg", JPEG_QUALITY),
				});
			} catch {
				// Draw can fail on protected/odd sources — skip the frame.
			}
		}
	} finally {
		video.removeAttribute("src");
		video.load();
		URL.revokeObjectURL(url);
	}
	return frames;
}
