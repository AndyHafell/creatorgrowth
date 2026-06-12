import { NextResponse } from "next/server";

// Part B v2 — the cut-LEARNING route. Takes the before→after cut diff (what the
// AI cut that the editor kept, and vice-versa) plus the editor's purple feedback
// notes, and asks Gemini what it SYSTEMATICALLY got wrong — returning 3–7 short,
// general rules in the editor's voice. Those rules merge into the rulebook that
// the cut route (./route.ts) injects as LEARNED EDITOR PREFERENCES, so the next
// video's first pass is already closer to the editor's taste.
//
// Stateless + BYO Gemini key per request, exactly like the cut route. The value
// compounds over many videos as the rulebook captures systematic errors.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GEMINI_TEXT_MODEL = "gemini-3.5-flash";

type Span = { startSec: number; endSec: number; text: string };

function readApiKey(req: Request): string | null {
	return req.headers.get("x-gemini-key")?.trim() || null;
}

const RESPONSE_SCHEMA = {
	type: "object",
	properties: {
		rules: {
			type: "array",
			items: {
				type: "object",
				properties: {
					rule: { type: "string" },
					rationale: { type: "string" },
				},
				required: ["rule", "rationale"],
			},
		},
	},
	required: ["rules"],
};

function fmtSpans(spans: Span[]): string {
	if (spans.length === 0) return "(none)";
	return spans
		.map(
			(s) =>
				`- [${s.startSec.toFixed(1)}-${s.endSec.toFixed(1)}] "${s.text.trim()}"`,
		)
		.join("\n");
}

function buildLearnPrompt({
	overCuts,
	misses,
	notes,
}: {
	overCuts: Span[];
	misses: Span[];
	notes: string[];
}): string {
	return [
		"You are the AI retention editor that made the FIRST cut pass on a creator's",
		"video. The creator then hand-corrected your cuts and left notes. Figure out",
		"what you SYSTEMATICALLY got wrong, and write 3–7 short, GENERAL rules — in the",
		"creator's voice, addressed to a future version of you — so your NEXT first pass",
		"matches their taste. Rules MUST generalize (NOT 'keep the bit at 2:34'); each",
		"one sentence. Each rule gets a one-line rationale citing the pattern you saw.",
		"If there is genuinely nothing systematic, return fewer rules. Return ONLY JSON.",
		"",
		"YOU CUT THESE, BUT THE CREATOR KEPT THEM (you were too aggressive here):",
		fmtSpans(overCuts),
		"",
		"YOU KEPT THESE, BUT THE CREATOR CUT THEM (you missed these):",
		fmtSpans(misses),
		"",
		"THE CREATOR'S NOTES (highest signal — each begins with its MM:SS timestamp):",
		notes.length ? notes.map((n) => `- ${n.trim()}`).join("\n") : "(none)",
	].join("\n");
}

export async function POST(req: Request) {
	const apiKey = readApiKey(req);
	if (!apiKey) {
		return NextResponse.json(
			{
				error:
					"Add your Gemini API key in Final Pass → API keys to learn from this edit.",
			},
			{ status: 400 },
		);
	}

	let body: { overCuts?: Span[]; misses?: Span[]; notes?: string[] };
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
	}

	const overCuts = Array.isArray(body.overCuts) ? body.overCuts : [];
	const misses = Array.isArray(body.misses) ? body.misses : [];
	const notes = Array.isArray(body.notes) ? body.notes : [];

	if (overCuts.length === 0 && misses.length === 0 && notes.length === 0) {
		return NextResponse.json(
			{ error: "Nothing to learn from — no edits or notes on this video." },
			{ status: 400 },
		);
	}

	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${apiKey}`;

	let resp: Response;
	try {
		resp = await fetch(url, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				contents: [
					{ parts: [{ text: buildLearnPrompt({ overCuts, misses, notes }) }] },
				],
				generationConfig: {
					responseMimeType: "application/json",
					responseSchema: RESPONSE_SCHEMA,
					temperature: 0.4,
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

	let parsed: { rules?: Array<{ rule?: string; rationale?: string }> };
	try {
		parsed = JSON.parse(text);
	} catch {
		return NextResponse.json(
			{ error: "Gemini returned non-JSON." },
			{ status: 502 },
		);
	}

	const rules = (Array.isArray(parsed.rules) ? parsed.rules : [])
		.map((r) => ({
			rule: String(r?.rule ?? "").trim(),
			rationale: String(r?.rationale ?? "").trim(),
		}))
		.filter((r) => r.rule.length > 0);

	return NextResponse.json({ rules });
}
