# CreatorGrowth Editor

A free, self-hostable, AI-assisted video editor for creators. This is the
editor behind [creatorgrowth.com](https://creatorgrowth.com) — the entire
thing, open source.

Built as a fork of [OpenCut](https://github.com/OpenCut-app/OpenCut) (MIT),
extended with an AI editing layer:

- **Raw Cut** — transcript-driven cutting. Load a clip, get a word-level
  transcript, cut the video by cutting the text. Includes a live channel so an
  AI agent (e.g. Claude Code) can push and adjust cuts while you watch.
- **Auto Magic** — AI camera direction. Analyzes the clip and places zooms,
  punch-ins, and reframes automatically (Gemini-powered).
- **Magic Review** — a keyboard-first review pass over every AI decision:
  approve, adjust, split, or reject each move without touching the mouse.
- **Cursor-sidecar zoom targeting** — record a tiny cursor telemetry log next
  to your screen recording ([`tools/cursor-sidecar`](tools/cursor-sidecar)),
  attach it to the clip, and Auto Magic zooms exactly where the mouse settled
  and clicked.
- **Motion graphics** — programmatic motion-graphic compositions rendered
  straight onto the timeline (`motion/`).

## Quickstart

Requirements: [Bun](https://bun.sh) 1.2+, Docker (for the local Postgres +
Redis), Node-compatible toolchain.

```bash
git clone https://github.com/AndyHafell/creatorgrowth.git
cd creatorgrowth/editor

# 1. Local infra (Postgres + Redis + Redis HTTP shim)
docker compose up -d db redis serverless-redis-http

# 2. Env
cp apps/web/.env.example apps/web/.env.local

# 3. Install + run (from apps/web)
cd apps/web
bun install
bun run dev
```

The app mounts under the `/editor` base path (build-time, see
`apps/web/next.config.ts`), so open **http://localhost:3000/editor**.

Production build: `bun run build` in `apps/web`, or build the whole stack with
`docker compose up -d --build web`.

## AI features — bring your own keys

The AI layer is BYO-key. Nothing phones home.

- **Gemini** (Auto Magic / Final Pass analysis): paste your key in the
  editor's Final Pass settings, or set `GEMINI_API_KEY` for the server-side
  route when self-hosting with Docker.
- **ElevenLabs Scribe** (optional cloud transcription): `ELEVENLABS_API_KEY`.
  Leave it unset and the route reports itself disabled; local transcription
  still works.

## cursor-sidecar

`tools/cursor-sidecar/` is a standalone macOS cursor telemetry logger
(Swift, ~one file). Run it alongside an OBS recording — an included OBS
script auto-starts and stops it with each recording — then attach the
`.ndjson` log to your clip via **Auto Magic → Attach cursor log…**. See its
[README](tools/cursor-sidecar/README.md).

## The full platform

The editor is one half of the stack — and the other half ships in this same
repo: the CreatorGrowth dashboard (idea pipeline, thumbnail studio, packaging
scoring, publishing) lives at the [repository root](../), with the editor
under `editor/`. Run both and you have the complete creatorgrowth.com stack
self-hosted: the dashboard serves `/`, this editor mounts at `/editor`.

## About this repo

This is a **snapshot mirror** of a private working repository, refreshed
periodically as a single clean commit (the private repo's history includes
deploy tooling and was not written to be public). Issues and PRs are welcome —
PRs may be applied upstream and land here in the next snapshot rather than
being merged directly.

Anything referencing `YOUR_VPS_IP` / `user@YOUR_VPS_IP` in docs or scripts is
a placeholder for your own server — the deploy flow is plain
`docker compose` behind any reverse proxy.

## Credits & license

- Fork of [OpenCut](https://github.com/OpenCut-app/OpenCut) — MIT. The
  original LICENSE is preserved at [LICENSE](LICENSE).
- Cursor dwell-detection adapted from
  [OpenScreen](https://github.com/siddharthvaddem/openscreen) — MIT. See
  attribution headers in `apps/web/src/lib/magic-pass/cursor-beats.ts` and
  `tools/cursor-sidecar/main.swift`, and [NOTICE.md](NOTICE.md).
- Everything added on top: MIT, same as upstream.

Made by [AI Andy](https://www.youtube.com/@theaiandy).
