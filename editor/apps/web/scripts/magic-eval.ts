// Offline eval harness for the Magic AutoPass director (Agent AutoPass v3).
// NOT part of the shipped bundle — run with bun from apps/web:
//
//   bun scripts/magic-eval.ts --video /tmp/autopass_v3/eval.mp4 \
//     --srt /tmp/autopass_v3/eval_audio.srt --out /tmp/autopass_v3/rounds/r1 \
//     --label "r1 baseline" [--cursor /path/to/sidecar.ndjson]
//
// Reproduces the production path end-to-end without a browser: SRT →
// pseudo-words → heuristics → chunked director calls (same
// buildDirectorPrompt, same parse) → stitched shot list, then EVALUATES it:
//   1. crop check (objective): cut the exact crop each reframe/zoom shows
//      from the nearest frame, ask Gemini "browser chrome visible? clear
//      subject?" → % chrome violations, % dead framing
//   2. pacing stats (pure): clips/min, mean hold, kind mix, zoom runs —
//      scored against the "not overwhelming" targets
//   3. judge pass: Gemini scores the whole shot list 1-10 on Andy's criteria
// Appends one summary line per round to <out>/../scores.log.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	mergeAdjacentReframes,
	splitScopeIntoChunks,
} from "../src/lib/magic-pass/chunking";
import { clampBrowserChrome } from "../src/lib/magic-pass/chrome-clamp";
import { cropRectForClip } from "../src/lib/magic-pass/crop";
import {
	cursorBeatCandidates,
	cursorHintLines,
	detectCursorDwells,
	parseCursorLog,
	rankAndSpaceDwells,
} from "../src/lib/magic-pass/cursor-beats";
import { buildDirectorPrompt } from "../src/lib/magic-pass/director-prompt";
import { parseRefinedPlan } from "../src/lib/magic-pass/gemini-parse";
import {
	detectBeats,
	detectBoundaries,
} from "../src/lib/magic-pass/heuristics";
import { pacingStats } from "../src/lib/magic-pass/pacing";
import {
	buildShotList,
	directorFrameTimes,
	sanitizeShotList,
	wordsToTranscriptLines,
} from "../src/lib/magic-pass/shot-list";
import {
	MAX_REFINE_FRAMES,
	type BeatCandidate,
	type MagicPlanClip,
	type TimelineWord,
} from "../src/lib/magic-pass/types";

const GEMINI_MODEL = "gemini-3.5-flash";
const ENV_PATH = `${process.env.HOME}/Documents/Claude Folder/.env`;

// ---------- args ----------

function arg(name: string, fallback?: string): string {
	const i = process.argv.indexOf(`--${name}`);
	if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
	if (fallback !== undefined) return fallback;
	console.error(`missing --${name}`);
	process.exit(1);
}

const VIDEO = arg("video");
const SRT = arg("srt");
const OUT = arg("out");
const LABEL = arg("label", "round");
/** Cap director chunks for cheap smoke runs; 0 = all. */
const MAX_EVAL_CHUNKS = Number.parseInt(arg("max-chunks", "0"), 10);
/** Sidecar cursor NDJSON (v4) — empty = v3 behavior exactly. */
const CURSOR = arg("cursor", "");

// ---------- gemini ----------

function geminiKey(): string {
	const env = readFileSync(ENV_PATH, "utf8");
	const m = env.match(/^Google_AI_Studio=(.+)$/m);
	if (!m) throw new Error(`Google_AI_Studio not found in ${ENV_PATH}`);
	return m[1].trim();
}

type Part =
	| { text: string }
	| { inlineData: { mimeType: string; data: string } };

async function callGemini({
	parts,
	apiKey,
	maxOutputTokens = 32768,
}: {
	parts: Part[];
	apiKey: string;
	maxOutputTokens?: number;
}): Promise<{ text: string; promptTokens: number; outputTokens: number }> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
	for (let attempt = 0; attempt < 3; attempt++) {
		const resp = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				contents: [{ role: "user", parts }],
				generationConfig: {
					temperature: 0.2,
					responseMimeType: "application/json",
					maxOutputTokens,
				},
			}),
		});
		if (resp.status === 429 || resp.status >= 500) {
			await new Promise((r) => setTimeout(r, 4000 * (attempt + 1)));
			continue;
		}
		if (!resp.ok) {
			throw new Error(`Gemini HTTP ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
		}
		const json = (await resp.json()) as {
			candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
			usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
		};
		return {
			text: json.candidates?.[0]?.content?.parts?.[0]?.text ?? "",
			promptTokens: json.usageMetadata?.promptTokenCount ?? 0,
			outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
		};
	}
	throw new Error("Gemini retries exhausted (429/5xx)");
}

// ---------- srt → words ----------

function parseSrtTime(t: string): number {
	const m = t.trim().match(/(\d+):(\d+):(\d+)[,.](\d+)/);
	if (!m) return 0;
	return +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
}

function srtToWords(srt: string): TimelineWord[] {
	const out: TimelineWord[] = [];
	for (const block of srt.split(/\n\s*\n/)) {
		const lines = block.trim().split("\n");
		const timeLine = lines.find((l) => l.includes("-->"));
		if (!timeLine) continue;
		const [a, b] = timeLine.split("-->");
		const start = parseSrtTime(a);
		const end = parseSrtTime(b);
		const text = lines.slice(lines.indexOf(timeLine) + 1).join(" ").trim();
		const tokens = text.split(/\s+/).filter(Boolean);
		if (tokens.length === 0) continue;
		const step = (end - start) / tokens.length;
		tokens.forEach((tok, i) => {
			out.push({ text: tok, start: start + i * step, end: start + (i + 1) * step });
		});
	}
	return out;
}

// ---------- ffmpeg ----------

async function run(cmd: string[]): Promise<void> {
	const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "pipe" });
	const code = await proc.exited;
	if (code !== 0) {
		throw new Error(`${cmd[0]} failed (${code}): ${await new Response(proc.stderr).text()}`);
	}
}

async function probeDims(video: string): Promise<{ w: number; h: number; durationSec: number }> {
	const proc = Bun.spawn(
		["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries",
			"stream=width,height:format=duration", "-of", "json", video],
		{ stdout: "pipe" },
	);
	const json = JSON.parse(await new Response(proc.stdout).text());
	return {
		w: json.streams[0].width,
		h: json.streams[0].height,
		durationSec: Number.parseFloat(json.format.duration),
	};
}

async function extractFrame({
	video, timeSec, outPath, vf,
}: { video: string; timeSec: number; outPath: string; vf: string }): Promise<void> {
	await run(["ffmpeg", "-y", "-v", "error", "-ss", timeSec.toFixed(3), "-i", video,
		"-frames:v", "1", "-vf", vf, "-q:v", "5", outPath]);
}

async function mapLimit<T, R>(
	items: T[], limit: number, fn: (item: T, i: number) => Promise<R>,
): Promise<R[]> {
	const out: R[] = new Array(items.length);
	let next = 0;
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (next < items.length) {
				const i = next++;
				out[i] = await fn(items[i], i);
			}
		}),
	);
	return out;
}

function b64Part(path: string): Part {
	return {
		inlineData: { mimeType: "image/jpeg", data: readFileSync(path).toString("base64") },
	};
}

/** JSON.parse that survives markdown fences and leading/trailing prose. */
function parseJsonLoose<T>(text: string): T | null {
	for (const candidate of [
		text,
		text.replace(/^[^{[]*/, "").replace(/[^}\]]*$/, ""),
	]) {
		try {
			return JSON.parse(candidate) as T;
		} catch {
			// try the next candidate
		}
	}
	return null;
}

// ---------- direction (mirrors the button's chunk loop) ----------

interface DirectResult {
	clips: MagicPlanClip[];
	chunkNotes: string[];
	promptTokens: number;
	outputTokens: number;
}

async function directFullVideo({
	words, durationSec, apiKey, framesDir, cursorCands = [],
}: {
	words: TimelineWord[];
	durationSec: number;
	apiKey: string;
	framesDir: string;
	cursorCands?: BeatCandidate[];
}): Promise<DirectResult> {
	const beats = [...detectBeats({ words }), ...cursorCands].sort(
		(a, b) => a.triggerStart - b.triggerStart,
	);
	const boundaries = detectBoundaries({ words });
	let chunks = splitScopeIntoChunks({ scopeStart: 0, scopeEnd: durationSec, boundaries });
	if (MAX_EVAL_CHUNKS > 0) chunks = chunks.slice(0, MAX_EVAL_CHUNKS);

	const directed: MagicPlanClip[] = [];
	const chunkNotes: string[] = [];
	let promptTokens = 0;
	let outputTokens = 0;

	for (let i = 0; i < chunks.length; i++) {
		const chunk = chunks[i];
		const fallback = buildShotList({
			beats, boundaries, scopeStart: chunk.start, scopeEnd: chunk.end,
		});
		const times = directorFrameTimes({
			scopeStart: chunk.start, scopeEnd: chunk.end, maxFrames: MAX_REFINE_FRAMES,
		});
		const framePaths = await mapLimit(times, 8, async (t) => {
			const p = join(framesDir, `f_${t.toFixed(1)}.jpg`);
			await extractFrame({ video: VIDEO, timeSec: t, outPath: p, vf: "scale=640:-2" });
			return { t, p };
		});

		const parts: Part[] = [
			{
				text: buildDirectorPrompt({
					fallback,
					transcriptLines: wordsToTranscriptLines({
						words, scopeStart: chunk.start, scopeEnd: chunk.end,
					}),
					scopeStart: chunk.start,
					scopeEnd: chunk.end,
					previousClip: directed[directed.length - 1] ?? null,
					cursorHints: cursorHintLines({
						candidates: cursorCands,
						scopeStart: chunk.start,
						scopeEnd: chunk.end,
					}),
				}),
			},
		];
		for (const f of framePaths) {
			parts.push({ text: `Frame at t=${f.t.toFixed(1)}s:` });
			parts.push(b64Part(f.p));
		}

		process.stdout.write(`directing ${i + 1}/${chunks.length}… `);
		try {
			const res = await callGemini({ parts, apiKey });
			promptTokens += res.promptTokens;
			outputTokens += res.outputTokens;
			const plan = parseRefinedPlan({ text: res.text, fallback });
			if (plan === fallback) chunkNotes.push(`chunk ${i + 1}: parse fallback`);
			directed.push(...plan.clips);
			console.log(`${plan.clips.length} clips`);
		} catch (err) {
			chunkNotes.push(`chunk ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
			directed.push(...fallback.clips);
			console.log("FAILED → heuristic");
		}
	}

	const scopeEnd = chunks[chunks.length - 1]?.end ?? durationSec;
	const clips = mergeAdjacentReframes(
		clampBrowserChrome(
			sanitizeShotList({ clips: directed, scopeStart: 0, scopeEnd }),
		),
	);
	return { clips, chunkNotes, promptTokens, outputTokens };
}

// ---------- eval 1: crop check ----------

interface CropVerdict {
	index: number;
	chromeVisible: boolean;
	clearSubject: boolean;
}

async function cropCheck({
	clips, frameW, frameH, apiKey, cropsDir,
}: {
	clips: MagicPlanClip[];
	frameW: number;
	frameH: number;
	apiKey: string;
	cropsDir: string;
}): Promise<{
	checked: number;
	chromeViolationPct: number;
	deadFramingPct: number;
	violations: Array<{ clip: MagicPlanClip; verdict: CropVerdict }>;
}> {
	const targets = clips.filter((c) => c.kind === "reframe" || c.kind === "zoom");
	const cropPaths = await mapLimit(targets, 8, async (clip, i) => {
		const mid = (clip.start + clip.end) / 2;
		const r = cropRectForClip({ clip, frameW, frameH });
		const p = join(cropsDir, `crop_${String(i).padStart(3, "0")}_${clip.kind}_${mid.toFixed(1)}s.jpg`);
		await extractFrame({
			video: VIDEO, timeSec: mid, outPath: p,
			vf: `crop=${Math.round(r.w)}:${Math.round(r.h)}:${Math.round(r.x)}:${Math.round(r.y)},scale='min(512,iw)':-2`,
		});
		return p;
	});

	const verdicts: CropVerdict[] = [];
	const BATCH = 12;
	for (let off = 0; off < cropPaths.length; off += BATCH) {
		const batch = cropPaths.slice(off, off + BATCH);
		const parts: Part[] = [
			{
				text: `Each image below is the EXACT crop a camera framing shows the viewer during a screen-recording video. For EACH image answer two things:
- chromeVisible: does the crop contain any part of a browser tab bar, URL/address bar, bookmarks bar, or the macOS menu bar? (true/false)
- clearSubject: does the crop have an obvious subject a viewer should be looking at (a panel, text block, button, person), rather than dead space / half-cut content? (true/false)
Return ONLY JSON: {"verdicts":[{"index":N,"chromeVisible":B,"clearSubject":B}]} with index matching the label before each image.`,
			},
		];
		batch.forEach((p, j) => {
			parts.push({ text: `Image index=${off + j}:` });
			parts.push(b64Part(p));
		});
		const res = await callGemini({ parts, apiKey, maxOutputTokens: 4096 });
		const parsed = parseJsonLoose<{ verdicts?: CropVerdict[] }>(res.text);
		if (parsed) {
			for (const v of parsed.verdicts ?? []) {
				if (typeof v?.index === "number") verdicts.push(v);
			}
		} else {
			console.error(`crop batch at ${off}: unparseable verdict, skipped`);
		}
	}

	const chromeViolations = verdicts.filter((v) => v.chromeVisible);
	const dead = verdicts.filter((v) => !v.clearSubject);
	return {
		checked: verdicts.length,
		chromeViolationPct: verdicts.length ? (chromeViolations.length / verdicts.length) * 100 : 0,
		deadFramingPct: verdicts.length ? (dead.length / verdicts.length) * 100 : 0,
		violations: [...chromeViolations, ...dead.filter((v) => !v.chromeVisible)].map(
			(v) => ({ clip: targets[v.index], verdict: v }),
		),
	};
}

// ---------- eval 2: judge ----------

async function judgeShotList({
	clips, durationSec, apiKey,
}: {
	clips: MagicPlanClip[];
	durationSec: number;
	apiKey: string;
}): Promise<Record<string, unknown>> {
	const compact = clips.map((c) => ({
		k: c.kind, s: Number(c.start.toFixed(1)), e: Number(c.end.toFixed(1)),
		sc: c.scale, fx: c.focalX, fy: c.focalY, r: c.reason,
	}));
	const parts: Part[] = [
		{
			text: `You are reviewing the full camera-direction shot list for a ${(durationSec / 60).toFixed(1)}-minute screen-recording YouTube video. The director's brief was:
1. FULL COVERAGE — every second camera-directed (reframe resting states + zoom punches + highlights), no dead stretches.
2. CALM PACING — long resting holds (6-15s), zooms only on genuinely strong beats, framing changes only when attention actually moves, never more than 2 zoom/highlight in a row. NOT overwhelming over 13 minutes.
3. PROFESSIONAL FRAMING — reframes rest on the working region, punch-ins land on specific targets, the video can breathe.

Shot list (k=kind, s/e=start/end sec, sc=scale, fx/fy=focal %, r=reason):
${JSON.stringify(compact)}

Score 1-10 on each criterion and overall (10 = ship it). Be a harsh professional editor. Return ONLY JSON:
{"coverage":N,"calmPacing":N,"framing":N,"overall":N,"worstProblem":"...","notes":"..."}`,
		},
	];
	const res = await callGemini({ parts, apiKey, maxOutputTokens: 8192 });
	return (
		parseJsonLoose<Record<string, unknown>>(res.text) ?? {
			overall: 0,
			notes: `unparseable: ${res.text.slice(0, 200)}`,
		}
	);
}

// ---------- main ----------

async function main() {
	const apiKey = geminiKey();
	mkdirSync(OUT, { recursive: true });
	const framesDir = join(OUT, "frames");
	const cropsDir = join(OUT, "crops");
	mkdirSync(framesDir, { recursive: true });
	mkdirSync(cropsDir, { recursive: true });

	const { w, h, durationSec } = await probeDims(VIDEO);
	console.log(`video ${w}x${h}, ${durationSec.toFixed(1)}s — label: ${LABEL}`);
	const words = srtToWords(readFileSync(SRT, "utf8"));
	console.log(`${words.length} pseudo-words from SRT`);

	// Cursor sidecar log (v4): eval media has no cuts, so media time IS
	// timeline time — one identity element window covers the whole video.
	let cursorCands: BeatCandidate[] = [];
	if (CURSOR) {
		const samples = parseCursorLog(readFileSync(CURSOR, "utf8"));
		const dwells = rankAndSpaceDwells(detectCursorDwells(samples));
		const tps = 1000;
		cursorCands = cursorBeatCandidates({
			dwells,
			elements: [
				{ startTime: 0, trimStart: 0, trimEnd: 0, duration: durationSec * tps },
			],
			ticksPerSecond: tps,
		});
		console.log(
			`cursor log: ${samples.length} samples → ${dwells.length} dwells → ${cursorCands.length} beat candidates`,
		);
	}

	const t0 = Date.now();
	const direction = await directFullVideo({ words, durationSec, apiKey, framesDir, cursorCands });
	const scopeEnd = MAX_EVAL_CHUNKS > 0
		? Math.max(...direction.clips.map((c) => c.end))
		: durationSec;
	const stats = pacingStats({ clips: direction.clips, scopeStart: 0, scopeEnd });
	console.log("pacing:", JSON.stringify(stats));

	console.log(`crop-checking ${direction.clips.filter((c) => c.kind !== "highlight").length} framings…`);
	const crops = await cropCheck({ clips: direction.clips, frameW: w, frameH: h, apiKey, cropsDir });
	console.log(`chrome violations: ${crops.chromeViolationPct.toFixed(1)}%  dead framing: ${crops.deadFramingPct.toFixed(1)}% (${crops.checked} checked)`);

	const judge = await judgeShotList({ clips: direction.clips, durationSec: scopeEnd, apiKey });
	console.log("judge:", JSON.stringify(judge));

	const report = {
		label: LABEL,
		video: VIDEO,
		durationSec: scopeEnd,
		elapsedSec: Math.round((Date.now() - t0) / 1000),
		clipCount: direction.clips.length,
		chunkNotes: direction.chunkNotes,
		tokens: { prompt: direction.promptTokens, output: direction.outputTokens },
		pacing: stats,
		crops: {
			checked: crops.checked,
			chromeViolationPct: crops.chromeViolationPct,
			deadFramingPct: crops.deadFramingPct,
			violations: crops.violations,
		},
		judge,
	};
	writeFileSync(join(OUT, "report.json"), JSON.stringify(report, null, 2));
	writeFileSync(join(OUT, "shotlist.json"), JSON.stringify(direction.clips, null, 2));

	const line = `${new Date().toISOString()} ${LABEL} | clips=${direction.clips.length} clips/min=${stats.clipsPerMin.toFixed(1)} meanHold=${stats.meanHoldSec.toFixed(1)}s zoomRun=${stats.maxConsecutiveZooms} cover=${stats.coveragePct.toFixed(0)}% short=${stats.shortHoldPct.toFixed(0)}% | chrome=${crops.chromeViolationPct.toFixed(1)}% dead=${crops.deadFramingPct.toFixed(1)}% | judge overall=${(judge as { overall?: number }).overall} calm=${(judge as { calmPacing?: number }).calmPacing} | ${direction.chunkNotes.length} chunk notes\n`;
	const scoresPath = join(dirname(OUT), "scores.log");
	writeFileSync(scoresPath, (await Bun.file(scoresPath).exists() ? await Bun.file(scoresPath).text() : "") + line);
	console.log(`\n${line}report: ${join(OUT, "report.json")}`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
