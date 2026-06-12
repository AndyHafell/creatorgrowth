import { NextResponse } from "next/server";
import { parseLiveCommand } from "@/lib/raw-cut/live-cuts";

// Live cut channel — the relay between an external editor agent (Claude Code)
// and a running Raw Cut browser session. In-memory, single-process (the editor
// runs as one bun process in its container); a deploy wipes channels, which is
// fine — the browser re-links with the same code and clamps its cursor.
//
//   POST { channel, push: LiveCommand }   agent → enqueue a command
//   POST { channel, state: {...} }        browser → report current cut state
//   GET  ?channel=X&after=N               browser → commands with seq > N
//   GET  ?channel=X&state=1               agent → latest reported state
//
// Auth: browser requests ride the Traefik member gate (CG session cookie).
// The agent pushes from INSIDE the perimeter — ssh to the VPS, wget against
// the container on localhost:3000 (see lib/raw-cut/live/push-cuts.ts) — so
// this route adds no public unauthenticated surface and needs no key.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Channel {
	commands: Array<{ seq: number; cmd: unknown }>;
	nextSeq: number;
	state: unknown;
	touchedAt: number;
}

const MAX_CHANNELS = 64;
const MAX_PENDING = 256;
const MAX_STATE_BYTES = 512 * 1024;
const TTL_MS = 2 * 60 * 60 * 1000;

const channels = new Map<string, Channel>();

function sweep() {
	const now = Date.now();
	for (const [key, ch] of channels) {
		if (now - ch.touchedAt > TTL_MS) channels.delete(key);
	}
	while (channels.size > MAX_CHANNELS) {
		const oldest = [...channels.entries()].sort(
			(a, b) => a[1].touchedAt - b[1].touchedAt,
		)[0];
		if (!oldest) break;
		channels.delete(oldest[0]);
	}
}

function getChannel(code: string): Channel {
	let ch = channels.get(code);
	if (!ch) {
		ch = { commands: [], nextSeq: 1, state: null, touchedAt: Date.now() };
		channels.set(code, ch);
	}
	ch.touchedAt = Date.now();
	return ch;
}

function validCode(code: unknown): code is string {
	return typeof code === "string" && /^[A-Za-z0-9-]{4,32}$/.test(code);
}

export async function GET(req: Request) {
	sweep();
	const url = new URL(req.url);
	const code = url.searchParams.get("channel");
	if (!validCode(code)) {
		return NextResponse.json({ error: "Bad channel code." }, { status: 400 });
	}
	const ch = getChannel(code);
	if (url.searchParams.get("state") === "1") {
		return NextResponse.json({ state: ch.state, latest: ch.nextSeq - 1 });
	}
	const after = Number(url.searchParams.get("after") ?? "0");
	const commands = ch.commands.filter((c) => c.seq > after);
	// `latest` lets a client whose cursor outran a restarted server clamp back.
	return NextResponse.json({ commands, latest: ch.nextSeq - 1 });
}

export async function POST(req: Request) {
	sweep();
	let body: { channel?: unknown; push?: unknown; state?: unknown };
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
	}
	if (!validCode(body.channel)) {
		return NextResponse.json({ error: "Bad channel code." }, { status: 400 });
	}
	const ch = getChannel(body.channel);

	if (body.push !== undefined) {
		const cmd = parseLiveCommand(body.push);
		if (!cmd) {
			return NextResponse.json(
				{ error: "Unrecognized live command." },
				{ status: 400 },
			);
		}
		if (ch.commands.length >= MAX_PENDING) ch.commands.shift();
		const seq = ch.nextSeq++;
		ch.commands.push({ seq, cmd });
		return NextResponse.json({ ok: true, seq });
	}

	if (body.state !== undefined) {
		if (JSON.stringify(body.state).length > MAX_STATE_BYTES) {
			return NextResponse.json({ error: "State too large." }, { status: 413 });
		}
		ch.state = body.state;
		return NextResponse.json({ ok: true });
	}

	return NextResponse.json(
		{ error: "Provide `push` or `state`." },
		{ status: 400 },
	);
}
