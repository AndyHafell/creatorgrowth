// Agent-side pusher for the live cut pipeline. Run from Claude Code on Andy's
// Mac; rides SSH into the VPS and talks to the editor container directly on
// localhost:3000, INSIDE the Traefik member gate — no public surface, no key.
//
//   bun run src/lib/raw-cut/live/push-cuts.ts <channel> set <cuts.json>
//   bun run src/lib/raw-cut/live/push-cuts.ts <channel> add <cuts.json>
//   bun run src/lib/raw-cut/live/push-cuts.ts <channel> adjust <at> <start> <end>
//   bun run src/lib/raw-cut/live/push-cuts.ts <channel> remove <at>
//   bun run src/lib/raw-cut/live/push-cuts.ts <channel> clear
//   bun run src/lib/raw-cut/live/push-cuts.ts <channel> run [--force]   # in-app AI pass
//   bun run src/lib/raw-cut/live/push-cuts.ts <channel> state
//
// Times accept "24:45", "24:45.5" or bare seconds. The channel code is shown
// in Raw Cut's "Live link" button (e.g. RC-A1B2C3).

import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const VPS = process.env.RAWCUT_VPS_SSH ?? "user@YOUR_VPS_IP";
const CONTAINER = "creatorgrowth-editor-web-1";
const URL_PATH = "http://0.0.0.0:3000/editor/api/final-pass/live-cuts";

// Self-recording corrections (the /rawcut learning loop): every mutating push
// is appended to a per-day-per-channel JSONL so the end-of-session distill
// ("just finished raw cuts") reads exactly what was changed and why. Pass
// --note "<why>" with any command to capture Andy's reasoning verbatim.
const LOG_DIR =
	process.env.RAWCUT_LOG_DIR ??
	join(homedir(), "Documents/Claude Folder/skills/content/rawcut_sessions");

function logCommand(
	channel: string,
	entry: Record<string, unknown>,
	note?: string,
) {
	try {
		mkdirSync(LOG_DIR, { recursive: true });
		const day = new Date().toISOString().slice(0, 10);
		appendFileSync(
			join(LOG_DIR, `${day}_${channel}.jsonl`),
			`${JSON.stringify({
				ts: new Date().toISOString(),
				channel,
				...entry,
				...(note ? { note } : {}),
			})}\n`,
		);
	} catch {
		/* logging must never block a push */
	}
}

function parseTime(raw: string): number {
	const m = raw.match(/^(\d+):(\d+(?:\.\d+)?)$/);
	if (m) return Number(m[1]) * 60 + Number(m[2]);
	const n = Number(raw);
	if (!Number.isFinite(n)) throw new Error(`Bad time: ${raw}`);
	return n;
}

async function remote(args: string[], stdin?: string): Promise<string> {
	const proc = spawnSync("ssh", [VPS, ...args], {
		input: stdin,
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
	});
	if (proc.status !== 0) {
		throw new Error(
			`ssh failed (${proc.status}): ${(proc.stderr ?? "").slice(0, 300)}`,
		);
	}
	return proc.stdout ?? "";
}

async function post(payload: unknown): Promise<string> {
	const json = JSON.stringify(payload);
	// $(cat) keeps the JSON intact through ssh + docker exec quoting.
	const cmd = `docker exec -i ${CONTAINER} sh -c 'wget -qO- --header="Content-Type: application/json" --post-data="$(cat)" ${URL_PATH}'`;
	return remote([cmd], json);
}

async function get(query: string): Promise<string> {
	const cmd = `docker exec ${CONTAINER} wget -qO- "${URL_PATH}?${query}"`;
	return remote([cmd]);
}

async function main() {
	const argv = process.argv.slice(2);
	// Extract --note "<why>" (any position) before positional parsing.
	let note: string | undefined;
	const noteIdx = argv.indexOf("--note");
	if (noteIdx !== -1) {
		note = argv[noteIdx + 1];
		argv.splice(noteIdx, 2);
	}
	const [channel, action, ...rest] = argv;
	if (!channel || !action) {
		console.error(
			'Usage: push-cuts.ts <channel> <set|add|adjust|remove|clear|run|state> [...] [--note "why"]',
		);
		process.exit(1);
	}

	let out: string;
	switch (action) {
		case "set":
		case "add": {
			const file = rest[0];
			if (!file) throw new Error(`${action} needs a cuts.json path`);
			const data = JSON.parse(readFileSync(file, "utf8")) as {
				cuts?: unknown[];
			};
			const cuts = data.cuts ?? data;
			out = await post({ channel, push: { action, cuts } });
			logCommand(channel, { action, file, cuts }, note);
			break;
		}
		case "adjust": {
			const [at, start, end] = rest.map(parseTime);
			out = await post({ channel, push: { action: "adjust", at, start, end } });
			logCommand(channel, { action, at, start, end }, note);
			break;
		}
		case "remove": {
			const at = parseTime(rest[0]);
			out = await post({ channel, push: { action: "remove", at } });
			logCommand(channel, { action, at }, note);
			break;
		}
		case "clear": {
			out = await post({ channel, push: { action: "clear" } });
			logCommand(channel, { action }, note);
			break;
		}
		case "run": {
			const force = rest.includes("--force");
			out = await post({
				channel,
				push: { action: "run-ai-cut", force },
			});
			logCommand(channel, { action: "run-ai-cut", force }, note);
			break;
		}
		case "state": {
			out = await get(`channel=${encodeURIComponent(channel)}&state=1`);
			break;
		}
		default:
			throw new Error(`Unknown action: ${action}`);
	}
	console.log(out);
}

main().catch((err) => {
	console.error((err as Error).message);
	process.exit(1);
});
