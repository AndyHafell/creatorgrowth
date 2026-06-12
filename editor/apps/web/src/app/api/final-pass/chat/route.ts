import { NextResponse } from "next/server";

// Step 4 — the AI Final Pass chatbot. This is the conversational successor to
// the static score readout: it OWNS the 1–10 score, knows the exact red cuts,
// and can change them through tools (function-calling) so the chat, the
// transcript, and the timeline all render from one cut state.
//
// The client holds the source of truth (cuts + score) and sends it each turn;
// this route runs Gemini's tool-call loop server-side against a working copy,
// applies the model's mutations, and returns the NEW cut list + score + reply.
// The client replaces its state with what comes back, so the model's edits show
// up as red on the transcript and the waveform immediately.
//
// Server-side so the Gemini key never reaches the client (same key/model as
// /api/final-pass).

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GEMINI_TEXT_MODEL = "gemini-3.5-flash";
const GREENLIT_CUTOFF = 7.0;
const MAX_TOOL_ROUNDS = 6;

type Segment = { text: string; start: number; end: number };
type Cut = {
	start: number;
	end: number;
	reason: string;
	kind: "fluff" | "filler";
};
type ChatMessage = { role: "user" | "assistant"; content: string };

// BYO-key: member's Gemini key per-request (x-gemini-key). No server fallback.
function readApiKey(req: Request): string | null {
	return req.headers.get("x-gemini-key")?.trim() || null;
}

function clampScore(n: unknown): number {
	const v = typeof n === "number" && Number.isFinite(n) ? n : 0;
	return Math.round(Math.max(1, Math.min(10, v)) * 10) / 10;
}

function sanitizeCut(c: {
	start?: unknown;
	end?: unknown;
	reason?: unknown;
	kind?: unknown;
}): Cut | null {
	const start = typeof c.start === "number" ? c.start : Number(c.start);
	const end = typeof c.end === "number" ? c.end : Number(c.end);
	if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
		return null;
	}
	return {
		start,
		end,
		reason: String(c.reason ?? ""),
		kind: c.kind === "filler" ? "filler" : "fluff",
	};
}

// --- Gemini function declarations (the tools the chat can call). ---
const TOOLS = [
	{
		functionDeclarations: [
			{
				name: "set_score",
				description:
					"Set the current 1–10 quality score for the video (one decimal). Use when you re-evaluate the video, not for the projected-after-cuts score.",
				parameters: {
					type: "object",
					properties: {
						score: { type: "number", description: "1.0–10.0, one decimal" },
					},
					required: ["score"],
				},
			},
			{
				name: "set_projected_score",
				description:
					"Set the score you estimate the video would reach IF the current cuts are applied. Call this in your opening message and whenever the cut list changes enough to move it.",
				parameters: {
					type: "object",
					properties: {
						score: { type: "number", description: "1.0–10.0, one decimal" },
					},
					required: ["score"],
				},
			},
			{
				name: "add_cut",
				description:
					"Add a new red cut to remove a fluff/filler segment. start/end are seconds in the video.",
				parameters: {
					type: "object",
					properties: {
						start: { type: "number" },
						end: { type: "number" },
						reason: { type: "string" },
						kind: { type: "string", enum: ["fluff", "filler"] },
					},
					required: ["start", "end", "reason", "kind"],
				},
			},
			{
				name: "remove_cut",
				description:
					"Remove a red cut by its index in the current cut list (0-based), so that segment is KEPT in the video.",
				parameters: {
					type: "object",
					properties: { index: { type: "number" } },
					required: ["index"],
				},
			},
			{
				name: "keep_cut",
				description:
					"Alias for remove_cut — the user wants to KEEP the segment at this cut index (un-cut it).",
				parameters: {
					type: "object",
					properties: { index: { type: "number" } },
					required: ["index"],
				},
			},
			{
				name: "update_cut",
				description:
					"Adjust an existing cut by index — change its start/end seconds, reason, or kind.",
				parameters: {
					type: "object",
					properties: {
						index: { type: "number" },
						start: { type: "number" },
						end: { type: "number" },
						reason: { type: "string" },
						kind: { type: "string", enum: ["fluff", "filler"] },
					},
					required: ["index"],
				},
			},
		],
	},
];

function systemInstruction({
	transcript,
	cuts,
	score,
}: {
	transcript: string;
	cuts: Cut[];
	score: number;
}): string {
	const cutList = cuts.length
		? cuts
				.map(
					(c, i) =>
						`  [${i}] ${c.start.toFixed(1)}–${c.end.toFixed(1)}s (${c.kind}): ${c.reason}`,
				)
				.join("\n")
		: "  (none yet)";
	return [
		"You are the AI Final Pass: a sharp, encouraging editing partner who has",
		"actually WATCHED this YouTube video (you have the full transcript). You are",
		"at once a fluff remover, a story/narrative expert, a YouTube packaging/retention",
		"expert, an analyzer, and the scorer. You OWN the 1–10 quality score and the",
		"red cut list — you can change both with your tools.",
		"",
		"Talk like a real editor in the room: specific, concrete, opinionated but fair,",
		'and willing to reason back and forth ("why did you cut that?" deserves a real',
		"answer, and you can be argued out of a cut). Reference actual lines/timestamps.",
		"Keep replies tight — a few sentences, not an essay — unless asked to go deep.",
		"",
		"WHEN THE USER ASKS YOU TO CHANGE CUTS (add, remove, keep, tighten, etc.), you",
		"MUST do it via the tools (add_cut/remove_cut/keep_cut/update_cut), then briefly",
		"confirm what you changed. Don't just describe a change — make it. Cut indices",
		"refer to the list below.",
		"",
		`CURRENT SCORE: ${score.toFixed(1)} / 10 (greenlit at ${GREENLIT_CUTOFF.toFixed(1)}+).`,
		"CURRENT RED CUTS (index: range, kind, reason):",
		cutList,
		"",
		"FULL TRANSCRIPT (seconds):",
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

	let body: {
		messages?: ChatMessage[];
		segments?: Segment[];
		cuts?: Cut[];
		score?: number;
		mode?: "init" | "chat";
	};
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
	}

	const segments = Array.isArray(body.segments) ? body.segments : [];
	if (segments.length === 0) {
		return NextResponse.json(
			{ error: "No transcript provided." },
			{ status: 400 },
		);
	}

	// Working copy of the state the tools mutate. Returned to the client at the end.
	const work = {
		cuts: (Array.isArray(body.cuts) ? body.cuts : [])
			.map((c) => sanitizeCut(c))
			.filter((c): c is Cut => c !== null),
		score: clampScore(body.score),
		projectedScore: null as number | null,
	};

	const transcript = segments
		.map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text.trim()}`)
		.join("\n");

	// Build the conversation. init mode synthesizes the opening directive so the
	// first thing Andy sees is the verdict in the required format.
	const contents: Array<{ role: string; parts: unknown[] }> = [];
	if (body.mode === "init") {
		contents.push({
			role: "user",
			parts: [
				{
					text: [
						"Open the conversation now — this is your opening VERDICT, not a report",
						"of edits. In THIS first message do NOT call add_cut, remove_cut,",
						"update_cut or keep_cut (the red cuts are already set); the only tool",
						"you may call here is set_projected_score. Follow this shape exactly:",
						`(1) Your FIRST sentence must begin with "I'm ranking your video a ${work.score.toFixed(1)}".`,
						"(2) Then, in a natural flowing paragraph, walk through the cuts that",
						"are ALREADY flagged and WHY each one weakens the video — reference real",
						"lines/timestamps. If there are no cuts yet, say it's already tight.",
						'(3) End with "if you cut these you can reach X.Y" and call',
						"set_projected_score with that number.",
						"Keep it punchy and human. From the NEXT message on, you can freely",
						"change the cuts with your tools.",
					].join(" "),
				},
			],
		});
	} else {
		const messages = Array.isArray(body.messages) ? body.messages : [];
		for (const m of messages) {
			contents.push({
				role: m.role === "assistant" ? "model" : "user",
				parts: [{ text: String(m.content ?? "") }],
			});
		}
		if (contents.length === 0) {
			return NextResponse.json(
				{ error: "No messages provided." },
				{ status: 400 },
			);
		}
	}

	const sys = systemInstruction({
		transcript,
		cuts: work.cuts,
		score: work.score,
	});
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_TEXT_MODEL}:generateContent?key=${apiKey}`;

	const toolCalls: Array<{ name: string; args: Record<string, unknown> }> = [];

	const applyTool = (
		name: string,
		args: Record<string, unknown>,
	): Record<string, unknown> => {
		toolCalls.push({ name, args });
		switch (name) {
			case "set_score":
				work.score = clampScore(args.score);
				return { ok: true, score: work.score };
			case "set_projected_score":
				work.projectedScore = clampScore(args.score);
				return { ok: true, projectedScore: work.projectedScore };
			case "add_cut": {
				const cut = sanitizeCut(args);
				if (!cut) return { ok: false, error: "invalid start/end" };
				work.cuts.push(cut);
				work.cuts.sort((a, b) => a.start - b.start);
				return { ok: true, cutCount: work.cuts.length };
			}
			case "remove_cut":
			case "keep_cut": {
				const i = Number(args.index);
				if (!Number.isInteger(i) || i < 0 || i >= work.cuts.length) {
					return { ok: false, error: "index out of range" };
				}
				const [removed] = work.cuts.splice(i, 1);
				return { ok: true, removed, cutCount: work.cuts.length };
			}
			case "update_cut": {
				const i = Number(args.index);
				if (!Number.isInteger(i) || i < 0 || i >= work.cuts.length) {
					return { ok: false, error: "index out of range" };
				}
				const cur = work.cuts[i];
				const merged = sanitizeCut({
					start: args.start ?? cur.start,
					end: args.end ?? cur.end,
					reason: args.reason ?? cur.reason,
					kind: args.kind ?? cur.kind,
				});
				if (!merged) return { ok: false, error: "invalid start/end" };
				work.cuts[i] = merged;
				work.cuts.sort((a, b) => a.start - b.start);
				return { ok: true, cut: merged };
			}
			default:
				return { ok: false, error: `unknown tool ${name}` };
		}
	};

	// Accumulate text across rounds: the model often emits its prose in the SAME
	// turn as its tool calls, so we can't wait for a tool-free turn to grab it.
	const replyChunks: string[] = [];
	try {
		for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
			const resp = await fetch(url, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					systemInstruction: { parts: [{ text: sys }] },
					contents,
					tools: TOOLS,
					generationConfig: { temperature: 0.5 },
				}),
			});
			if (!resp.ok) {
				const detail = await resp.text();
				return NextResponse.json(
					{ error: `Gemini ${resp.status}: ${detail.slice(0, 300)}` },
					{ status: 502 },
				);
			}
			const data = await resp.json();
			const parts: Array<{
				text?: string;
				functionCall?: { name: string; args?: Record<string, unknown> };
			}> = data?.candidates?.[0]?.content?.parts ?? [];

			const text = parts
				.map((p) => p.text ?? "")
				.join("")
				.trim();
			if (text) replyChunks.push(text);

			const calls = parts.filter((p) => p.functionCall);
			if (calls.length === 0) break;

			// Echo the model's function-call turn, then answer each call.
			contents.push({ role: "model", parts });
			const responseParts = calls.map((p) => {
				const fc = p.functionCall as {
					name: string;
					args?: Record<string, unknown>;
				};
				const result = applyTool(fc.name, fc.args ?? {});
				return {
					functionResponse: { name: fc.name, response: { result } },
				};
			});
			contents.push({ role: "user", parts: responseParts });
		}
	} catch (err) {
		return NextResponse.json(
			{ error: `Gemini request failed: ${(err as Error).message}` },
			{ status: 502 },
		);
	}

	// Dedupe identical chunks: gemini-3.5 often re-emits the same prose in the
	// round after a tool call, which doubled the opening verdict.
	let reply = [...new Set(replyChunks)].join("\n\n").trim();
	if (!reply) {
		reply =
			toolCalls.length > 0 ? "Done — updated your cuts." : "(no response)";
	}

	return NextResponse.json({
		reply,
		cuts: work.cuts,
		score: work.score,
		verdict: work.score >= GREENLIT_CUTOFF ? "greenlit" : "not-greenlit",
		projectedScore: work.projectedScore,
		toolCalls,
	});
}
