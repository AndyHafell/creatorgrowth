import type { MagicPlan, MagicPlanClip } from "./types";

// The Gemini vision DIRECTOR prompt (v3). Extracted from refine.ts so the
// offline eval harness can build the exact production prompt without pulling
// in the fetch/budget plumbing. v3 over v2: calm pacing for full-length
// videos (long resting holds, hysteresis, zoom restraint), a hard
// browser-chrome exclusion rule (Andy: "not so much of the URL and Chrome in
// the top"), and continuity context so chunked windows direct as one video.

export function describeClipForPrompt(clip: MagicPlanClip): string {
	return (
		`${clip.kind} at scale ${clip.scale} focal (${clip.focalX}, ${clip.focalY})` +
		`, ${clip.start.toFixed(1)}-${clip.end.toFixed(1)}s — "${clip.reason}"`
	);
}

export function buildDirectorPrompt({
	fallback,
	transcriptLines,
	scopeStart,
	scopeEnd,
	previousClip,
	cursorHints,
}: {
	fallback: MagicPlan;
	transcriptLines: string[];
	scopeStart: number;
	scopeEnd: number;
	/** Last clip of the previous chunk — continuity across window borders. */
	previousClip?: MagicPlanClip | null;
	/** Recorded mouse dwells (sidecar log) — exact focals, v4. Empty = v3 prompt. */
	cursorHints?: string[];
}): string {
	const hintLines = fallback.clips
		.filter((c) => c.kind !== "reframe")
		.map(
			(c) =>
				`- ${c.start.toFixed(1)}-${c.end.toFixed(1)}s ${c.kind}: ${c.reason}`,
		)
		.join("\n");
	const cursor =
		cursorHints && cursorHints.length > 0
			? `CURSOR HINTS — recorded mouse telemetry (timeline seconds, focal in percent). These are EXACT positions where the presenter's mouse settled; [clicked/clickable] marks a click or a hover over a button/link:
${cursorHints.join("\n")}
When you place a zoom or highlight near one of these moments, use the recorded focal — it beats any visual guess. A dwell is permission, not obligation: the pacing rules below still decide IF a moment earns a zoom; the hint only decides WHERE it lands. CROSS-CHECK against the frames: if the frames show no meaningful subject at a recorded position, the mouse was probably just parked — ignore that hint. Cursor hints never apply to resting reframes: frame those on the visible content as usual.
`
			: "";
	const continuity = previousClip
		? `\nPREVIOUS WINDOW: this window continues a longer video. The camera state entering it is: ${describeClipForPrompt(previousClip)}. Start your first clip FROM this framing (same scale/focal) unless the content at ${scopeStart.toFixed(1)}s has clearly changed — a seam the viewer can feel between windows is a direction error.\n`
		: "";
	return `You are the camera director for a long-form screen-recording YouTube video. You direct where the viewer looks: framing, punch-ins, and text highlights. Your shot list covers the window ${scopeStart.toFixed(1)}s to ${scopeEnd.toFixed(1)}s of the timeline.

TRANSCRIPT (timeline seconds):
${transcriptLines.join("\n")}

${hintLines ? `TRIGGER-PHRASE HINTS from a transcript heuristic (use or override them):\n${hintLines}\n` : ""}${cursor}${continuity}
After this text you get frames sampled across the window, each labeled with its timeline second. The recording is mostly a screen capture; some frames may show a webcam/talking-head shot.

Write the COMPLETE shot list for the window. Three clip kinds:
- "reframe" — the RESTING state: a locked framing on the screen region currently being worked in. This is the default camera. 6-15s per clip — hold a good framing while the speaker stays on it; up to 20s is fine when attention genuinely doesn't move. scale 1.15-1.6 for screen work (2-2.5 only when the action lives in one small area for a sustained stretch). For a talking-head/webcam frame use scale 1 (full frame).
- "zoom" — a punch-in on one specific moment: a decisive click, a "look at this", a reveal, a number that matters. 2.5-5s. scale 1.8-2.6 for buttons and small UI, up to 3 for tiny targets. focalX/focalY on the exact target.
- "highlight" — one specific text being read aloud (a prompt, code line, command, number). 2.5-4s. Give region {x,y,w,h} (percent) TIGHTLY around that text.

PACING — this is a long video, restraint wins, but calm is not frozen:
- HYSTERESIS: keep the current framing while the viewer's attention target stays put — never change framing just to change it.
- BUT never let one identical framing run past ~25s. During a long explanation on one region, vary it gently — and CONCRETELY: consecutive holds on the same subject must differ by at least 0.15 scale, DRIFTING in one direction like a slow documentary push-in (1.5 → 1.65 → 1.8, then release wider on the next thought). Never ping-pong (1.8 → 1.6 → 1.8). The drift stays within ±0.3 of the base framing — it is NOT a cumulative escalation toward maximum zoom. Or step the focal down the page following the reading flow. A slow sequence of 10-20s holds reads calm; a 40-second freeze reads like a broken video.
- RESTING REFRAMES NEVER EXCEED scale 2.6. If a subject would need more than 2.6 to fill the frame (a small webcam tile in a strip, a tiny status bar), it is NOT a framing subject — stay on the main content instead. Over-zooming pixelates a 1080p recording.
- When speakers trade short remarks rapidly, do NOT chase every turn — hold the wider framing (full grid / main content) until one speaker clearly holds the floor again.
- During one person's long monologue, an occasional listener-reaction cut is welcome — but SPARINGLY: at most one per minute, 5-8s long (shorter reads as a nervous tennis match). Otherwise stay with the speaker and vary the push-in instead. Never park on one face for 30s+.
- Zooms and highlights are earned beats: at most 2-3 per minute COMBINED, only on genuinely strong moments. Weak trigger phrases ("you can see", "here we have") do NOT earn a zoom. But when the material offers a strong moment, TAKE it — roughly 1-2 earned punches per minute keeps a long video alive; several minutes with zero punches reads unedited.
- Never more than 2 zoom/highlight clips in a row; return to a resting reframe between punches and let it breathe for at least 6s.
- After a zoom, return to the SAME resting framing you left (the viewer keeps their mental map), unless attention moved.
- Multi-person webcam grid: don't hold the full grid for minutes — alternate framing the ACTIVE speaker (scale 1.6-2.2 on their tile) every 10-20s, returning to the full grid for group moments.

FRAMING QUALITY — frame the content, not the window:
- Every framing must have ONE obvious subject filling most of the frame: a text column, a panel, a person, a diagram. Exclude side navigation, empty margins, black letterbox bands, and half-visible panels.
- When text is being read, frame the TEXT COLUMN so it fills most of the frame width (usually scale 1.4-1.8), and follow the reading position down the page across consecutive reframes.
- A small webcam strip or PiP at an edge: either frame it fully OUT or make it the full subject — never half-cut it at the frame edge.

BROWSER CHROME — hard rule:
- When the screen shows a browser, NEVER include the browser tab bar, URL bar / address bar, bookmarks bar, or the macOS menu bar in a reframe or zoom framing. Frame BELOW them.
- DO THE GEOMETRY — the crop's top edge sits at (focalY − 50/scale) percent of the screen height. Browser chrome (with menu bar and a possible bookmarks bar) fills the top ~13%. So for browser content ALWAYS pick focalY ≥ 13 + 50/scale. Examples: scale 1.2 → focalY ≥ 55; scale 1.35 → ≥ 50; scale 1.5 → ≥ 47; scale 1.8 → ≥ 41; scale 2.2 → ≥ 36. If the subject sits high on the page and that focalY would miss it, INCREASE the scale (a tighter crop pushes the top edge down) rather than letting chrome into frame.
- The ONLY exception: the narration is explicitly about the URL, the tabs, or browser controls at that moment.
- This rule beats "full frame": for browser content do NOT use scale 1 — the resting frame is a slight push-in that crops the chrome off. Scale 1 is reserved for webcam/talking-head moments or non-browser screens whose top edge matters.
- Set "browser": true on every clip whose visible content is a web browser window (tabs, URL bar, or a web page layout); false for webcam grids, native apps, terminals, slides.

Hard rules:
- Clips are contiguous and non-overlapping: each clip's start equals the previous clip's end. The first clip starts at ${scopeStart.toFixed(1)}, the last ends at ${scopeEnd.toFixed(1)}. Every second is covered.
- focalX/focalY are percent (0-100) of the frame. Pick them from the labeled frame nearest the clip's time.
- easeIn/easeOut: 0 for reframe; 0.5 for zoom/highlight (0.3 when shorter than 2.5s).
- reason: under 8 words, naming the visual target ("code panel left half", "punch on Run button").

Return ONLY valid JSON, no prose:
{"clips":[{"kind":"reframe|zoom|highlight","start":N,"end":N,"scale":N,"focalX":N,"focalY":N,"region":{"x":N,"y":N,"w":N,"h":N},"easeIn":N,"easeOut":N,"reason":"...","browser":true|false}]}`;
}
