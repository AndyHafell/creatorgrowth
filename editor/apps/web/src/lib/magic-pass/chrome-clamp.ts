import type { MagicPlanClip } from "./types";

// Deterministic enforcement of the browser-chrome rule. The director prompt
// asks for focalY ≥ 11 + 50/scale on browser content, but a vision model
// doing geometry is best-effort — this clamp makes it structural. The model
// only has to CLASSIFY (browser: true/false per clip); the math happens here.
// Browser chrome (macOS menu bar + tabs + URL bar + a possible bookmarks
// bar) fills up to ~13% of a fullscreen 1080p browser; a crop whose top edge
// sits below that never shows it.

const CHROME_TOP_PCT = 13;
/** Minimum push-in for browser content — scale 1 cannot crop the chrome off. */
const MIN_BROWSER_SCALE = 1.15;

export function clampBrowserChrome(
	clips: MagicPlanClip[],
	{ chromeTopPct = CHROME_TOP_PCT }: { chromeTopPct?: number } = {},
): MagicPlanClip[] {
	return clips.map((clip) => {
		if (!clip.browser || clip.kind === "highlight") return clip;
		const scale = Math.max(clip.scale, MIN_BROWSER_SCALE);
		const minFocalY = chromeTopPct + 50 / scale;
		if (clip.scale === scale && clip.focalY >= minFocalY) return clip;
		return { ...clip, scale, focalY: Math.max(clip.focalY, minFocalY) };
	});
}
