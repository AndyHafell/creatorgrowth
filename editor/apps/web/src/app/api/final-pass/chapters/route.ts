import { NextResponse } from "next/server";

// Final Pass — chapter detection. Takes the timestamped transcript and asks
// Gemini to segment the video into YouTube-style chapters (Intro + the actual
// steps/sections), each with a start time and a short title. Andy verifies the
// titles/timings in the UI, then exports them straight into the description.
//
// Output contract (consumed by final-pass-surface.tsx):
//   { chapters: [{ time, title }] }  // time in seconds, ascending, first = 0
//
// Server-side so the Gemini key never reaches the client (same key/model as the
// other final-pass routes).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GEMINI_TEXT_MODEL = "gemini-3.5-flash";

type Segment = { text: string; start: number; end: number };

// BYO-key: member's Gemini key per-request (x-gemini-key). No server fallback.
function readApiKey(req: Request): string | null {
	return req.headers.get("x-gemini-key")?.trim() || null;
}

const RESPONSE_SCHEMA = {
	type: "object",
	properties: {
		chapters: {
			type: "array",
			items: {
				type: "object",
				properties: {
					time: { type: "number" },
					title: { type: "string" },
				},
				required: ["time", "title"],
			},
		},
	},
	required: ["chapters"],
};

function buildPrompt(transcript: string): string {
	return [
		"You are a YouTube editor writing the CHAPTER markers for a video's",
		"description. Below is the timestamped transcript (seconds). Segment the",
		"video into clear, watchable chapters and return ONLY JSON matching the",
		"schema.",
		"",
		"Rules:",
		'- The FIRST chapter MUST have time 0 and a title like "Intro".',
		'- Detect the real structure. If the creator says "step one / step 2 /',
		'  next step", make a chapter per step and title it like',
		'  "Step 1: <what it is>" (a few words, concrete — not just "Step 1").',
		"- Otherwise use natural section titles (2–6 words, specific, no fluff).",
		"- Use the transcript timestamps for each chapter's start time (seconds).",
		"- Aim for 4–12 chapters. Don't over-segment; each chapter should be a",
		"  meaningful stretch, not every sentence.",
		"- Titles are for a YouTube description: punchy, lowercase-ok, no quotes.",
		"",
		"TRANSCRIPT:",
		transcript,
	].join("\n");
}

export async function POST(req: Request) {
	const apiKey = readApiKey(req);
	if (!apiKey) {
		return NextResponse.json(
			{ error: "Add your Gemini API key in Final Pass → API keys." },
			{ status: 400 },
		);
	}

	let body: { segments?: Segment[] };
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
	}

	const segments = Array.isArray(body.segments) ? body.segments : [];
	if (segments.length === 0) {
		return NextResponse.json(
			{ error: "No transcript segments provided." },
			{ status: 400 },
		);
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
				contents: [{ parts: [{ text: buildPrompt(transcript) }] }],
				generationConfig: {
					responseMimeType: "application/json",
					responseSchema: RESPONSE_SCHEMA,
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

	let parsed: { chapters?: Array<{ time?: number; title?: string }> };
	try {
		parsed = JSON.parse(text);
	} catch {
		return NextResponse.json(
			{ error: "Gemini returned non-JSON." },
			{ status: 502 },
		);
	}

	// Sanitize: numeric ascending times, non-empty titles, force a 0:00 opener.
	const seen = new Set<string>();
	let chapters = (Array.isArray(parsed.chapters) ? parsed.chapters : [])
		.map((c) => ({
			time:
				typeof c?.time === "number" && Number.isFinite(c.time)
					? Math.max(0, c.time)
					: Number.NaN,
			title: String(c?.title ?? "").trim(),
		}))
		.filter((c) => Number.isFinite(c.time) && c.title.length > 0)
		.sort((a, b) => a.time - b.time)
		.filter((c) => {
			// Drop duplicate timestamps (1s resolution — YouTube chapter granularity).
			const key = Math.round(c.time).toString();
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});

	if (chapters.length === 0 || chapters[0].time > 0.5) {
		chapters = [{ time: 0, title: "Intro" }, ...chapters];
	} else {
		chapters[0] = { ...chapters[0], time: 0 };
	}

	return NextResponse.json({ chapters });
}
