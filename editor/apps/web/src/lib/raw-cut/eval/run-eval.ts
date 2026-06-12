// Eval runner: grade the Raw Cut AI engine against the Fable 5 reference edit.
//
//   bun run src/lib/raw-cut/eval/run-eval.ts [transcript.txt]
//     → runs the real chunked engine (Gemini, GEMINI_API_KEY env or
//       ~/Documents/Claude Folder/.env) on the transcript and scores it.
//   bun run src/lib/raw-cut/eval/run-eval.ts --cuts some_cuts.json
//     → scores an existing {cuts:[{start,end,...}]} list without any API call.
//
// Transcript format: one "[m:ss-m:ss] text" line per segment (original media
// coords, silences already removed) — /tmp/fable5/speech.txt.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import {
	RAW_KINDS,
	type RawCut,
	type RawTranscriptSegment,
	runRawAnalysis,
} from "../raw-analysis";
import { FABLE5_REFERENCE } from "./reference-fable5";
import { scoreAgainstReference } from "./score";

const GEMINI_TEXT_MODEL = "gemini-3.5-flash";

function parseTimestamp(ts: string): number {
	const [m, s] = ts.split(":").map(Number);
	return m * 60 + s;
}

function parseTranscript(path: string): RawTranscriptSegment[] {
	const out: RawTranscriptSegment[] = [];
	for (const line of readFileSync(path, "utf8").split("\n")) {
		const m = line.match(/^\[(\d+:\d+)-(\d+:\d+)\]\s*(.+)$/);
		if (!m) continue;
		out.push({
			start: parseTimestamp(m[1]),
			end: parseTimestamp(m[2]),
			text: m[3].trim(),
		});
	}
	return out;
}

function readGeminiKey(): string {
	if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY;
	const envPath = `${homedir()}/Documents/Claude Folder/.env`;
	for (const line of readFileSync(envPath, "utf8").split("\n")) {
		const m = line.match(/^GEMINI_API_KEY\s*=\s*"?([^"\s]+)"?/);
		if (m) return m[1];
	}
	throw new Error("GEMINI_API_KEY not found (env or Claude Folder/.env)");
}

function responseSchema() {
	return {
		type: "object",
		properties: {
			score: { type: "number" },
			verdict: { type: "string", enum: ["greenlit", "not-greenlit"] },
			reason: { type: "string" },
			cuts: {
				type: "array",
				items: {
					type: "object",
					properties: {
						start: { type: "number" },
						end: { type: "number" },
						reason: { type: "string" },
						kind: { type: "string", enum: [...RAW_KINDS] },
						confidence: { type: "number" },
					},
					required: ["start", "end", "reason", "kind", "confidence"],
				},
			},
		},
		required: ["score", "verdict", "reason", "cuts"],
	};
}

async function callGemini(apiKey: string, prompt: string): Promise<unknown> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${apiKey}`;
	const attempt = async (): Promise<unknown> => {
		const resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ parts: [{ text: prompt }] }],
				generationConfig: {
					responseMimeType: "application/json",
					responseSchema: responseSchema(),
					temperature: 0.3,
				},
			}),
		});
		if (!resp.ok) {
			throw new Error(
				`Gemini ${resp.status}: ${(await resp.text()).slice(0, 200)}`,
			);
		}
		const data = (await resp.json()) as {
			candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
		};
		const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
		if (!text) throw new Error("Empty response from Gemini.");
		return JSON.parse(text) as unknown;
	};
	try {
		return await attempt();
	} catch (err) {
		console.error(`  (retrying one call: ${(err as Error).message})`);
		return await attempt();
	}
}

// Mirror of ai-cut.ts shouldApplyCut (red-or-nothing): cuts at/above the floor
// apply directly; below-floor finds are dropped. Grade exactly what would land
// on Andy's timeline.
const APPLY_CONFIDENCE_FLOOR = 0.65;

function printScorecard(cuts: RawCut[], label: string) {
	const applied = cuts.filter((c) => c.confidence >= APPLY_CONFIDENCE_FLOOR);
	const card = scoreAgainstReference({
		reference: FABLE5_REFERENCE,
		engineCuts: applied,
	});
	const spans = applied.map((c) => c.end - c.start);
	const avg = spans.length
		? spans.reduce((a, b) => a + b, 0) / spans.length
		: 0;
	console.log(`\n=== Scorecard: ${label} (red-or-nothing) ===`);
	console.log(
		`cuts applied: ${applied.length} of ${cuts.length} returned (avg span ${avg.toFixed(1)}s)`,
	);
	console.log(`recall:        ${card.hits}/${card.total}`);
	console.log(`marker recall: ${card.markerHits}/${card.markerTotal}`);
	for (const m of card.missed) {
		console.log(
			`  MISSED  [${fmt(m.start)}-${fmt(m.end)}] cov=${m.coverage} ${m.label}`,
		);
	}
	console.log(
		`keep violations (applied cuts): ${card.keepViolations.length}/4`,
	);
	for (const v of card.keepViolations) {
		console.log(`  VIOLATED ${v.label} — ${v.seconds}s wrongly cut`);
	}
}

function fmt(sec: number): string {
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

async function main() {
	const args = process.argv.slice(2);
	const cutsIdx = args.indexOf("--cuts");
	if (cutsIdx !== -1) {
		const path = args[cutsIdx + 1];
		const data = JSON.parse(readFileSync(path, "utf8")) as { cuts: RawCut[] };
		printScorecard(data.cuts, path);
		return;
	}

	const transcriptPath = args[0] ?? "/tmp/fable5/speech.txt";
	const segments = parseTranscript(transcriptPath);
	if (segments.length === 0)
		throw new Error(`No segments in ${transcriptPath}`);
	const end = segments[segments.length - 1].end;
	console.log(
		`Transcript: ${segments.length} segments, ${fmt(end)} span. Running chunked engine…`,
	);
	const apiKey = readGeminiKey();
	const t0 = Date.now();
	let calls = 0;
	const result = await runRawAnalysis({
		segments,
		callModel: (prompt) => {
			calls++;
			const n = calls;
			console.log(`  call ${n} started (${prompt.length} chars)`);
			return callGemini(apiKey, prompt).then((r) => {
				console.log(`  call ${n} done`);
				return r;
			});
		},
	});
	console.log(
		`Engine done: ${calls} calls in ${((Date.now() - t0) / 1000).toFixed(0)}s — score ${result.score}, "${result.reason}"`,
	);
	const outPath = `/tmp/fable5/eval_engine_${Date.now()}.json`;
	writeFileSync(outPath, JSON.stringify(result, null, 2));
	console.log(`Saved engine output → ${outPath}`);
	printScorecard(result.cuts, "chunked engine (live Gemini)");
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
