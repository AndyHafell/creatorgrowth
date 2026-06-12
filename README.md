# CreatorGrowth

The content operations platform behind [creatorgrowth.com](https://creatorgrowth.com) — where a YouTube channel's whole pipeline lives, from raw idea to published video.

It started as a thumbnail/idea dashboard and grew into a multi-tenant workspace: drag ideas across a Kanban pipeline, generate and score thumbnails + titles, cut raw footage in a browser editor, and track everything to publish — without juggling a dozen tools.

---

## What it does

- **Idea → Publish pipeline.** A board with tabs for `Ideas → Best → Packaging → Script → Edited → Published → Archived`. Cards carry the YouTube metadata, content doc, thumbnail, and status; drag them between stages.
- **Thumbnail studio.** Generate thumbnail options from viral inspiration, transform them for originality, and edit them in-app (`thumb_editor`). Packaging scoring rates thumbnail + title against click-psychology criteria.
- **Raw Cut editor.** A browser video editor (an OpenCut fork — see [Related repos](#related-repos)) embedded at `/editor`, including **Raw Cut**: a TimeBolt-style silence cutter that turns a 2-hour talking-head take into a tight cut with keyboard shortcuts, then sends the result to the timeline.
- **Diagrams & chapters.** In-editor asset producers (`diagram_image_editor`) for explainer visuals and auto-chapters.
- **Multi-tenant by design.** Each creator gets their own workspace with bring-your-own API keys, face references, and prompt presets. Team workspaces let an owner invite collaborators.
- **Skool-gated access (or open).** The hosted creatorgrowth.com verifies membership against a Skool community (email login → 7-day trial → paid conversion). Running your own copy? Set `OPEN_SIGNUP=1` and the gate disappears — any email gets permanent full access. See [Self-hosting](#self-hosting).

## Stack

| Layer | Tech |
|---|---|
| Backend | Python 3.12, **Flask** + Gunicorn |
| Data | SQLite (`videos.db`, `ideas.db`, `dashboard.db`) — gitignored, live on the server |
| Video metadata | `yt-dlp` + YouTube Data API |
| Media / storage | `boto3` (S3 / NAS) for finished exports and uploads |
| Transactional email | Resend (login codes) |
| Auth | Cookie sessions, Skool-handle allowlist, DM-code verification |
| Packaging / thumbnails | Gemini image + text models |
| Frontend | Server-rendered templates + the OpenCut-fork editor (Next.js, separate repo) |
| Runtime | Docker, served behind Cloudflare |

## Project structure

```
app.py                     # The Flask app — routes, auth, pipeline, thumbnail + editor APIs
templates/                 # index (dashboard), thumb_editor, diagram_image_editor
static/                    # JS/CSS/assets + uploads
scripts/
  skool_allowlist.py       # Skool membership allowlist
  skool_dm_verify.py       # DM-code verification flow
  skool_member_sync.py     # Nightly member sync (revoke cancellations)
  skool_cron.sh            # Cron entrypoint for the sync
  backfill_face_refs.py    # One-off: backfill per-user face references
sync_my_channel.py         # Pull a channel's published videos into the dashboard
llm_link_published_cards.py# Match published videos back to their pipeline cards
prompts/                   # Prompt templates
Dockerfile                 # python:3.12-slim + ffmpeg + yt-dlp + Node
deploy.sh / rebuild.sh     # Server-side deploy helpers
```

## Local development

Requires Python 3.12 (and `ffmpeg` + `yt-dlp` on PATH for media features).

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Minimum env (see Configuration). A random SECRET_KEY is used if unset,
# but it logs everyone out on restart — set one for anything real.
export SECRET_KEY="dev-secret"

python app.py        # http://localhost:5000
```

The SQLite databases are created on first run and are **not** tracked in git.

## Self-hosting

The default auth path gates access behind a Skool community — that's for the hosted creatorgrowth.com. To run your own instance, flip on **open mode**:

```bash
export OPEN_SIGNUP=1
```

With `OPEN_SIGNUP=1`:

- Any email that signs in gets **permanent, full access** — no 7-day trial, no day-7 auto-revoke, no Skool membership required.
- The "Join AI Mate" CTAs and the membership funnel are hidden; the front door is a plain email → code login.
- If you haven't configured an email provider (`RESEND_API_KEY`), the 6-digit login code is shown right on the login screen (and printed to the container logs), so you can sign in with no inbox at all.

Everything else still works in open mode — multi-tenant workspaces, team invites, bring-your-own API keys (set your own Replicate / Gemini keys per user in Settings), face references, and prompt presets.

## Configuration

Set via environment (a `.env`-style file on the server). Key variables:

| Variable | Purpose |
|---|---|
| `SECRET_KEY` | Flask session signing. **Must be pinned in prod** — a per-process random logs users out on every restart. |
| `YOUTUBE_API_KEY` | Batched video metadata (avoids the per-video `yt-dlp` bot wall). |
| `GEMINI_API_KEY` | Thumbnail + packaging generation. |
| `RESEND_*` | Login-code email delivery. |
| AWS / S3 creds | `boto3` storage for exports + uploads. |

> Never commit secrets or the live `*.db` files.

## Deployment

Runs as a Docker container on the server. From the deploy host:

```bash
./rebuild.sh "optional commit message"
```

`rebuild.sh` commits the current **code** (the live `*.db` files are gitignored so a `git reset` can't clobber production data), then rebuilds and restarts the container via `docker compose`.

GitHub is a separate remote from the server — push code there explicitly:

```bash
git push origin master
```

## Related repos

- **Editor (OpenCut fork)** — lives in this repo under [`editor/`](editor/): the Next.js browser video editor embedded at `/editor` — Raw Cut silence cutting, Auto Magic AI camera direction, Magic Review. See [editor/README.md](editor/README.md).

---

This is a **snapshot mirror** of the private working repositories, refreshed periodically as a single clean commit. Issues and PRs are welcome — PRs may be applied upstream and land here in the next snapshot rather than being merged directly.
