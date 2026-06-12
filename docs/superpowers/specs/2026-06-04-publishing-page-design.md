# Publishing Page — Design Spec

- **Date:** 2026-06-04
- **Repo:** creatorgrowth (`~/dev/creatorgrowth`)
- **Status:** Locked, ready for incremental build

## Summary

A new **Publishing** page in CreatorGrowth that clones YouTube Studio's *Video Details* layout and adds the three things Studio can't do: an **AI Final Review** score, **cross-post to all platforms** (BYO Blotato), and a **plan-only schedule** with a tiny calendar. It is the missing final stage of the content pipeline (edit → package → **publish**). It reuses the existing card data (`video_details`) and render components — **no new data model**.

The reason to mirror Studio's look is familiarity: Andy knows that layout cold, zero learning curve. The only things worth building are what Studio doesn't do.

## Goals

- One page to take a publish-ready card live: **review → finalize packaging + description/chapters → schedule → cross-post**.
- Familiar: mirror YT Studio Video Details so there's zero learning curve.
- **Reuse, don't rebuild**: the card's 9 thumbs / 9 titles, the content-doc render, `publish-blotato`, `youtube_publisher`.
- Buildable **incrementally** (see Build Order) — filmable step by step, not big-bang.

## Non-goals (explicitly skip — stay in real Studio)

- A/B title testing, end screens, cards, quizzes, monetization audit, playlists.
- Auto-scheduler / background daemon — schedule is **plan-only + manual fire**.
- New thumbnail/title *generation* UI — reuse the card's existing generate flow.

## Layout (two-pane + right rail, cloned from Studio)

- **Top tab bar:** `[ Publish | Context ]`; right side `[ Save ] [ Publish ▸ ]`.
- **Left — Ready Queue:** publish-ready cards (status `edited`/`review`), each showing its Final Review score; click to load into the workspace.
- **Center — Publish tab:**
  - **My Thumbnails + Titles** — *exact card layout*: 3 thumbs per row with their 3 titles directly beneath, ×3 = 9 + 9. Built by calling the existing `renderThumbs`/`renderTitles` into the already-present `_studio` container. Click a thumb/title to set the live one.
  - **Description + Chapters** — reuse the modal doc-editor render. "Generate" drafts the description + auto-chapters (timestamps) from the transcript so chapters render on YouTube.
- **Center — Context tab:** the full card info, read-only, displayed clean — content doc · prep doc · brief · packaging notes. Same data the card modal already loads, just laid out better. This is the "transparency into the content doc/prep" requirement.
- **Right rail:**
  - Video **preview** + **Visibility** dropdown (cloned from Studio).
  - **AI Final Review** *(new)* — score X/10 + short feedback vs channel history.
  - **Cross-post** *(new)* — platform toggles, gated on the user's Blotato key.
  - **Schedule + tiny calendar** *(new)* — plan-only target date; calendar shows scheduled + published.

## The four jobs

### 1. AI Final Review (the score)

- **Inputs:** the selected packaging (live title + thumb), the video **transcript** (Whisper, fast + free), and **channel background** — past videos' performance (ranking by views like the dashboard's "10 of 10," CTR, AVD).
- **Output:** a predicted **score (X/10)** + short feedback (what's strong, what's weak vs the channel average). **Advisory, not a hard gate** — a low score still lets you publish; it's a "should I even publish this" sanity check, a real final review.
- **Reuse:** the already-jotted "auto-predictor based on edit + packaging" idea + the channel-performance data already in the dashboard. Transcript via Whisper on the local video file.

### 2. Description + chapters

- Edit the YouTube description; **Generate** drafts it and auto-generates chapters (timestamps) from the transcript.
- **Reuse:** the modal `.modal-doc-editor` component.

### 3. Schedule (plan-only)

- Pick a target date/time; stored on the card (`scheduled_at`). Shows on the tiny calendar. **No background job** — Andy clicks **Publish ▸** when the time comes.

### 4. Cross-post (all platforms, BYO Blotato)

- Per-platform toggles (YouTube, X, Instagram, TikTok, LinkedIn).
- **Publish ▸** fires `youtube_publisher` (YouTube) + `publish-blotato` (the rest), using the **user's own Blotato API key**.
- **Gated:** disabled until the user adds their Blotato key in Settings.

## Settings addition

- A per-user **Blotato API key** field. Reuses the Settings-v2 social-connect slot / `_SETTINGS_V2_GATE` that's already stubbed. When present, `_can_publish_blotato()` returns true for that user and cross-post unlocks. (Per the multi-tenant rule: BYO keys in Settings, no admin gates.)

## Data model (reuse — no new tables)

- `video_details`: `original_thumbs` (9), `original_titles` (9), content doc, `custom_fields`, `meta`.
- `videos`: `status`, `published_at`; **add `scheduled_at`** (nullable) for the plan-only schedule.
- Final Review result cached on the card (`meta` JSON: `score`, `feedback`, `generated_at`).
- Blotato key: per-user setting (users table / settings store, alongside other Settings-v2 keys).

## Reuse vs build

**Reuse:** `renderThumbs`/`renderTitles` + `_studio` container · modal doc-editor · `/api/videos/<id>/publish-blotato` · `youtube_publisher.py` · channel performance data · Settings-v2 key slot.

**Build new:** Publishing page shell + route + nav tab · Ready Queue · Final Review endpoint (transcript + score) · description/chapters Generate · `scheduled_at` + calendar · Blotato key Settings field + per-user gate · Context tab.

## Build order (incremental — film each step as its own chapter)

1. **Page shell** — route + nav tab; render the Ready Queue (cards in `edited`/`review`).
2. **Packaging** — drop the existing thumbs/titles render (`_studio`) into center; wire "set live."
3. **Description + chapters** — reuse doc-editor; add **Generate**.
4. **Right rail static** — preview + visibility (cloned, static first).
5. **AI Final Review** — endpoint (transcript + channel data → score) + score card.
6. **Schedule** — `scheduled_at` + tiny calendar.
7. **Settings** — BYO Blotato key + per-user gate.
8. **Cross-post wiring** — Publish ▸ → `youtube_publisher` + `publish-blotato`.
9. **Context tab** — full card info, clean.

Each step is independently shippable and demoable — that's the filming spine (one step = one chapter = one Mindflow node).

## Open questions (resolve while building)

- Where the content-doc text is actually stored (file under `CONTENT_DIR` vs a DB field) — confirm the doc-editor's source at step 9.
- v1 cross-post platform set (default YouTube + X + Instagram?).
- Transcript: which Whisper (faster-whisper local?) and where the video file is read from.
