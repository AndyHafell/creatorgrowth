import { NextResponse } from "next/server";
import { RAW_KINDS, runRawAnalysis } from "@/lib/raw-cut/raw-analysis";

// Step 3 — the only new backend for Final Pass. Takes the edited video's
// timestamped transcript, asks Gemini for an editorial read (a 1–10 story/edit
// score + the fluff/filler to cut, each with a reason) and returns the
// structured verdict. Server-side so the key never reaches the client.
//
// Two modes (body.mode):
//   "final" (default) — the original Final Pass read on an already-edited video.
//   "raw" — Raw Cut's AI pass on raw footage: hunts retakes / false starts /
//           markers / tangents with a confidence per cut. Long transcripts are
//           CHUNKED into ~12-min overlapping windows plus one whole-file
//           cross-distance retake pass, merged server-side (lib/raw-cut/
//           raw-analysis.ts) — the client contract is unchanged.
//
// Output contract (final-pass-surface.tsx + raw-cut-surface.tsx):
//   { score, verdict, reason, cuts: [{ start, end, reason, kind, confidence }] }

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GEMINI_TEXT_MODEL = "gemini-3.5-flash";
const GREENLIT_CUTOFF = 7.0;

type Segment = { text: string; start: number; end: number };

// BYO-key: the member's Gemini key arrives per-request (x-gemini-key; see
// lib/final-pass/api-keys.ts). No server-key fallback — a shared platform key on
// a public/free-trial editor would let anyone burn our quota.
function readApiKey(req: Request): string | null {
	return req.headers.get("x-gemini-key")?.trim() || null;
}

type Mode = "final" | "raw";

const FINAL_KINDS = ["fluff", "filler"] as const;

function responseSchema(mode: Mode) {
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
						kind: {
							type: "string",
							enum: [...(mode === "raw" ? RAW_KINDS : FINAL_KINDS)],
						},
						confidence: { type: "number" },
					},
					required: ["start", "end", "reason", "kind", "confidence"],
				},
			},
		},
		required: ["score", "verdict", "reason", "cuts"],
	};
}

// mode:"final" prompt only — mode:"raw" prompts live in lib/raw-cut/
// raw-analysis.ts (windowed + retake-pass variants).
function buildPrompt({
	transcript,
	rulebook,
	outline,
}: {
	transcript: string;
	rulebook?: string;
	outline?: string;
}): string {
	// LEARNED EDITOR PREFERENCES (Part B): the creator's own cut rules, injected so
	// the first pass matches their taste. They OVERRIDE the defaults on conflict.
	const rules = rulebook?.trim();
	const rulesBlock = rules
		? [
				"",
				"LEARNED EDITOR PREFERENCES — the creator wrote these rules about how",
				"THEY want cuts made. Follow them; where they conflict with your default",
				"instincts, the creator's rules WIN:",
				rules,
				"",
			]
		: [];
	const plan = outline?.trim();
	const outlineBlock = plan
		? [
				"",
				"VIDEO OUTLINE — the creator's plan for this video. Use it to tell a",
				"tangent from the actual point. Do NOT cut content merely because it",
				"isn't in the outline (filming reveals new beats); cut it only when it",
				"doesn't serve the video:",
				plan,
				"",
			]
		: [];
	return [
		"You are a RUTHLESS YouTube retention editor doing the final pass on a",
		"creator's already-edited video before publish. Your job is to protect the",
		"viewer's time and find EVERY second that doesn't earn its place. Below is",
		"the timestamped transcript (seconds). Return ONLY JSON matching the schema.",
		...rulesBlock,
		...outlineBlock,
		"",
		"1) SCORE the video 1.0–10.0 (one decimal) on hook, pacing, payoff, clarity,",
		"   and absence of fluff — judge only what the words show. Be a harsh, honest",
		"   critic: you are NOT here to flatter, and grade inflation is a failure.",
		"   Calibrate against this rubric and DEFAULT to the 5–6 band unless the",
		"   video genuinely earns more:",
		"     9–10 = exceptional, zero fat, gripping start to finish (very rare)",
		"     7–8  = strong; only minor trims needed",
		"     5–6  = solid core but real fluff / pacing dips drag it down (most videos)",
		"     3–4  = significant problems: weak hook, rambling, dead air, repetition",
		"     1–2  = not publishable as-is",
		"   A long talking-head build almost never deserves above a 7 in its first",
		"   edit. Give a one-sentence reason naming the single biggest weakness.",
		"",
		"2) Find EVERY segment to CUT — be exhaustive, NOT selective. Scan the whole",
		'   transcript end to end and cut at the sentence/phrase level. kind "fluff"',
		"   = rambling, tangents, over-explanation, repeated or redundant points,",
		"   weak/low-information sentences, slow ramp-ups, throat-clearing, meandering",
		'   setups — anything a viewer would skip. kind "filler" = um, uh, like, you',
		"   know, false starts, restarts. For each, return start/end in seconds drawn",
		"   from the transcript ranges and a short, specific reason. A 30-minute first",
		"   edit typically has 15–40 cuttable moments — if you found only a handful,",
		"   you are not looking hard enough: re-scan. Only return an empty array if",
		"   the video is genuinely airtight (it almost never is). For each cut also",
		"   return a confidence 0.0–1.0 — how certain a good editor would be that",
		"   it must go.",
		"",
		"TRANSCRIPT:",
		transcript,
	].join("\n");
}

function clampScore(n: unknown): number {
	const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
	return Math.round(Math.max(1, Math.min(10, v)) * 10) / 10;
}

// One Gemini call with the raw-mode schema, parsed. The chunked raw analysis
// fans out into several of these; a transient failure on any one would kill
// the whole run, so each call retries once before giving up.
async function callGeminiRaw({
	apiKey,
	prompt,
}: {
	apiKey: string;
	prompt: string;
}): Promise<unknown> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${apiKey}`;
	const attempt = async (): Promise<unknown> => {
		const resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [{ parts: [{ text: prompt }] }],
				generationConfig: {
					responseMimeType: "application/json",
					responseSchema: responseSchema("raw"),
					temperature: 0.3,
				},
			}),
		});
		if (!resp.ok) {
			const detail = await resp.text();
			throw new Error(`Gemini ${resp.status}: ${detail.slice(0, 300)}`);
		}
		const data = await resp.json();
		const text: string | undefined =
			data?.candidates?.[0]?.content?.parts?.[0]?.text;
		if (!text) throw new Error("Empty response from Gemini.");
		return JSON.parse(text) as unknown;
	};
	try {
		return await attempt();
	} catch {
		return await attempt();
	}
}

export async function POST(req: Request) {
	const apiKey = readApiKey(req);
	if (!apiKey) {
		return NextResponse.json(
			{
				error:
					"Add your Gemini API key in Final Pass → API keys to run the analysis.",
			},
			{ status: 400 },
		);
	}

	let body: {
		segments?: Segment[];
		rulebook?: string;
		mode?: string;
		outline?: string;
	};
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
	}

	const mode: Mode = body.mode === "raw" ? "raw" : "final";
	const segments = Array.isArray(body.segments) ? body.segments : [];
	if (segments.length === 0) {
		return NextResponse.json(
			{ error: "No transcript segments provided." },
			{ status: 400 },
		);
	}

	if (mode === "raw") {
		// Chunked engine: ~12-min overlapping windows + one whole-file retake
		// pass, merged/deduped in lib. Same response contract as before.
		try {
			const result = await runRawAnalysis({
				segments,
				rulebook: body.rulebook,
				outline: body.outline,
				callModel: (prompt) => callGeminiRaw({ apiKey, prompt }),
			});
			return NextResponse.json({
				score: result.score,
				verdict: result.score >= GREENLIT_CUTOFF ? "greenlit" : "not-greenlit",
				reason: result.reason,
				cuts: result.cuts,
			});
		} catch (err) {
			return NextResponse.json(
				{ error: `Gemini analysis failed: ${(err as Error).message}` },
				{ status: 502 },
			);
		}
	}

	const transcript = segments
		.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text.trim()}`)
		.join("\n");

	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${apiKey}`;

	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [
					{
						parts: [
							{
								text: buildPrompt({
									transcript,
									rulebook: body.rulebook,
									outline: body.outline,
								}),
							},
						],
					},
				],
				generationConfig: {
					responseMimeType: "application/json",
					responseSchema: responseSchema(mode),
					temperature: 0.3,
				},
			}),
		});
	} catch (err) {
		return NextResponse.json(
			{ error: `Gemini request failed: ${(err as Error).message}` },
			{ status: 502 },
		);
	}

	if (!resp.ok) {
		const detail = await resp.text();
		return NextResponse.json(
			{ error: `Gemini ${resp.status}: ${detail.slice(0, 300)}` },
			{ status: 502 },
		);
	}

	const data = await resp.json();
	const text: string | undefined =
		data?.candidates?.[0]?.content?.parts?.[0]?.text;
	if (!text) {
		return NextResponse.json(
			{ error: "Empty response from Gemini." },
			{ status: 502 },
		);
	}

	let parsed: {
		score?: number;
		reason?: string;
		cuts?: Array<{
			start?: number;
			end?: number;
			reason?: string;
			kind?: string;
			confidence?: number;
		}>;
	};
	try {
		parsed = JSON.parse(text);
	} catch {
		return NextResponse.json(
			{ error: "Gemini returned non-JSON." },
			{ status: 502 },
		);
	}

	// Only mode:"final" reaches here — raw returned above.
	const validKinds: readonly string[] = FINAL_KINDS;
	const score = clampScore(parsed.score);
	const cuts = (Array.isArray(parsed.cuts) ? parsed.cuts : [])
		.filter(
			(c) =>
				typeof c?.start === "number" &&
				typeof c?.end === "number" &&
				(c.end as number) > (c.start as number),
		)
		.map((c) => ({
			start: c.start as number,
			end: c.end as number,
			reason: String(c.reason ?? ""),
			kind: validKinds.includes(c.kind ?? "") ? (c.kind as string) : "fluff",
			// Missing/garbage confidence lands mid-band (review queue), never auto-apply.
			confidence:
				typeof c.confidence === "number" && Number.isFinite(c.confidence)
					? Math.max(0, Math.min(1, c.confidence))
					: 0.7,
		}));

	// Verdict is derived from the score so it always matches the cutoff Andy
	// sees, regardless of what the model labels it.
	return NextResponse.json({
		score,
		verdict: score >= GREENLIT_CUTOFF ? "greenlit" : "not-greenlit",
		reason: String(parsed.reason ?? ""),
		cuts,
	});
}
