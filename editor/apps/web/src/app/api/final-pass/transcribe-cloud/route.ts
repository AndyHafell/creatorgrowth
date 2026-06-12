import { NextResponse } from "next/server";

// Final Pass — cloud transcription via ElevenLabs Scribe. The in-browser Whisper
// is fast but only "tiny" is quick enough, and tiny's timestamps are too loose
// for word-accurate red/green + chapter timing. Scribe returns WORD-level
// timestamps in seconds, which we group into read-along lines. Server-side so the
// key never reaches the client.
//
//   GET  -> { enabled: boolean }                 // is a key configured?
//   POST  (multipart: file=<audio wav>)          // returns { segments, text, words }
//
// Output contract (consumed by final-pass-surface.tsx + raw-cut-surface.tsx):
//   { segments: [{ text, start, end }], text, words: [{ text, start, end }] }
// `words` are the raw word-level timings — Raw Cut snaps cut boundaries onto
// word gaps so a cut can never clip a word tail. Older callers ignore it.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Allow the audio upload through (a 30-min 16kHz WAV is ~57 MB).
export const maxDuration = 300;

const SCRIBE_MODEL = "scribe_v1";
const ELEVEN_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text";

// BYO-key: member's ElevenLabs key per-request (x-eleven-key). No server
// fallback — without a key the client uses the free in-browser Whisper instead.
function readApiKey(req: Request): string | null {
	return req.headers.get("x-eleven-key")?.trim() || null;
}

type ScribeWord = {
	text?: string;
	start?: number;
	end?: number;
	type?: string;
};

// Group word-level tokens into read-along lines: break on sentence-ending
// punctuation, a >0.8s pause, or ~14 words — whichever comes first. Each line's
// start/end come straight from the word timestamps, so they're tight.
function wordsToSegments(
	words: ScribeWord[],
): Array<{ text: string; start: number; end: number }> {
	const segs: Array<{ text: string; start: number; end: number }> = [];
	let cur: { text: string; start: number; end: number; count: number } | null =
		null;
	let lastEnd = 0;

	const flush = () => {
		if (cur && cur.text.trim().length > 0) {
			segs.push({ text: cur.text.trim(), start: cur.start, end: cur.end });
		}
		cur = null;
	};

	for (const w of words) {
		if (w.type && w.type !== "word") continue; // skip spacing / audio_event
		const text = (w.text ?? "").trim();
		if (!text) continue;
		const start = typeof w.start === "number" ? w.start : lastEnd;
		const end = typeof w.end === "number" ? w.end : start;
		lastEnd = end;
		if (!cur) {
			cur = { text, start, end, count: 1 };
		} else {
			const gap = start - cur.end;
			cur.text += ` ${text}`;
			cur.end = end;
			cur.count += 1;
			if (gap > 0.8 || cur.count >= 14 || /[.?!]$/.test(text)) {
				flush();
			}
		}
		if (cur && /[.?!]$/.test(text)) flush();
	}
	flush();
	return segs;
}

export async function GET() {
	// Cloud transcription is always available — whether a given member can use it
	// depends on their own ElevenLabs key, which is a client-side concern now.
	return NextResponse.json({ enabled: true });
}

export async function POST(req: Request) {
	const apiKey = readApiKey(req);
	if (!apiKey) {
		return NextResponse.json(
			{ error: "Add your ElevenLabs API key in Final Pass → API keys." },
			{ status: 400 },
		);
	}

	let inForm: FormData;
	try {
		inForm = await req.formData();
	} catch {
		return NextResponse.json(
			{ error: "Expected multipart form-data with a `file`." },
			{ status: 400 },
		);
	}
	const file = inForm.get("file");
	if (!(file instanceof Blob)) {
		return NextResponse.json({ error: "Missing `file`." }, { status: 400 });
	}

	const outForm = new FormData();
	outForm.set("model_id", SCRIBE_MODEL);
	outForm.set("timestamps_granularity", "word");
	outForm.set("file", file, "audio.wav");

	let resp: Response;
	try {
		resp = await fetch(ELEVEN_STT_URL, {
			method: "POST",
			headers: { "xi-api-key": apiKey },
			body: outForm,
		});
	} catch (err) {
		return NextResponse.json(
			{ error: `ElevenLabs request failed: ${(err as Error).message}` },
			{ status: 502 },
		);
	}

	if (!resp.ok) {
		const detail = await resp.text();
		return NextResponse.json(
			{ error: `ElevenLabs ${resp.status}: ${detail.slice(0, 300)}` },
			{ status: 502 },
		);
	}

	const data = (await resp.json()) as { text?: string; words?: ScribeWord[] };
	const rawWords = Array.isArray(data.words) ? data.words : [];
	const segments = wordsToSegments(rawWords);
	if (segments.length === 0 && data.text) {
		// No word timings came back — fall back to a single block so the user at
		// least sees the transcript.
		segments.push({ text: data.text, start: 0, end: 0 });
	}
	// Clean word timings for boundary snapping (spacing/audio_event dropped).
	const words = rawWords
		.filter(
			(w) =>
				(!w.type || w.type === "word") &&
				(w.text ?? "").trim().length > 0 &&
				typeof w.start === "number" &&
				typeof w.end === "number",
		)
		.map((w) => ({
			text: (w.text as string).trim(),
			start: w.start as number,
			end: w.end as number,
		}));
	return NextResponse.json({ segments, text: data.text ?? "", words });
}
