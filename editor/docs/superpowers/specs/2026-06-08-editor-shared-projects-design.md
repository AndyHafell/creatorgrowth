# Editor Shared Projects ("Share" / "Open from Cloud") — v1 Design

**Date:** 2026-06-08
**Author:** Andy + Claude
**Status:** Draft for review
**Repo:** `creatorgrowth-editor` (OpenCut fork, Next.js, served on VPS)

---

## Problem

The Creator Growth Editor is today a **100% local-to-the-browser** app:

- Projects (timeline, cuts, layers, text, effects, settings) live in **IndexedDB** (`video-editor-projects`).
- Imported media (video clips, MP3s, images) live in **OPFS** (`media-files-{projectId}`), raw bytes + IndexedDB metadata.
- The VPS only runs auth, AI/motion services, and feedback. There is **no** server-side project or media sync, and **no** export/import bundle.

So a project Ham builds on his Mac is invisible to Andy on a different machine. We want a **handoff workflow**:

> Ham builds the raw cut on his computer → clicks **Share** → it lives on the web → Andy opens the editor on his machine, finds Ham's shared edit in a **Cloud Projects** panel, clicks it, and is looking at the **exact** project — every timeline, folder, cut, layer, and MP3 intact — ready to do the final cut. Andy never downloads or manages a `.zip` on his own disk.

### Confirmed requirements (from brainstorm)

1. **Accessible from another computer.** Same web editor, project state lives on the web.
2. **Share → Open round-trip preserves everything.** Full fidelity: timelines, tracks, folders, every media file.
3. **Stays on the web.** No manual file download/upload by the user; the browser fetches and unpacks directly into the editor.
4. **Find by a simple list.** A "Cloud Projects" panel; click an entry named like `Ham · Ep#9 · raw cut · Jun 8 14:30` to load it.
5. **Sequential, role-based handoff** (Ham raw cut → Andy final cut), not simultaneous co-editing.
6. **Keep it simple.** "Click Share → it makes a bundle → I open/unbundle it." MVP appetite, upgrade later.

### Explicitly out of scope for v1

- Real-time collaborative editing (Google-Docs / CRDT style).
- A hard lock mechanism. (See "Why no lock in v1" below — the local-until-Share model already satisfies "I can't access it while he's editing.")
- Unifying editor login with creatorgrowth.com login (see Assumptions).
- Content-addressed / incremental media de-dup (this is the documented v2 upgrade for large projects).

---

## The model: immutable named snapshots

- A **Shared Bundle** = one immutable snapshot of a project at the moment **Share** was clicked, owned by a team and tagged `author · project name · optional stage label · date·time`.
- Each click of **Share** creates a **new** bundle. Nothing is ever overwritten → free version history, and Ham's raw cut can never be clobbered by Andy's final cut.
- A bundle = a **manifest** (the full project JSON: scenes, tracks, elements, settings, version) + the **media** it references.
- The **Cloud Projects panel** lists the team's bundles, newest first, grouped/filterable by project name.

### Why no lock in v1

The original ask was "I shouldn't be able to access it while he's editing." With the snapshot model this is satisfied implicitly: **in-progress work is local-only until Share is clicked.** There is nothing on the web to open until Ham deliberately shares it. A hard "check-out lock" (one person holds the project, the other is blocked) is a clean v2 addition if forking ever becomes a real problem, but for a 2–3 person sequential pipeline it is unnecessary complexity.

---

## User flow

### Share (Ham, after raw cut)

1. Ham clicks **Share** in the editor toolbar.
2. A small dialog: project name (prefilled), optional stage label (e.g. "raw cut"). Confirm.
3. The editor packages the current project: project JSON + all **locally-imported** media bytes from OPFS; media that is **already in shared storage** (the "mix of both" case) is recorded as a URL reference, not re-uploaded.
4. The package is uploaded to the web (S3). A new bundle row is registered.
5. Toast: "Shared as `Ham · Ep#9 · raw cut · Jun 8 14:30`." Ham keeps editing locally if he wants; his shared snapshot is frozen.

### Open from Cloud (Andy, for final cut)

1. Andy opens the **Cloud Projects** panel.
2. He sees `Ham · Ep#9 · raw cut · Jun 8 14:30`. Clicks **Open**.
3. The browser downloads the manifest + media from the web and unpacks them into Andy's local OPFS + IndexedDB as a new local project, then opens it.
4. Andy sees the exact timeline, every layer, every MP3. He does the final cut and clicks **Share** again → a new bundle `Andy · Ep#9 · final cut · Jun 8 16:10` appears for the team.

---

## Architecture

Three pieces: client packager/unpacker, server API + DB, and S3 storage.

### 1. Storage (S3) — reuse CG's existing infra

CreatorGrowth already has multi-tenant S3 with BYO-or-Andy-fallback creds and per-user prefixes (`project_creatorgrowth_s3_video_storage`). Bundles live under a **shared team prefix**, not a per-user one:

```
team/{teamId}/editor-bundles/{bundleId}/manifest.json
team/{teamId}/editor-bundles/{bundleId}/media/{mediaId}.{ext}
```

- `manifest.json` = the serialized project (the existing `SerializedProject` shape) + a media list: for each `mediaId`, either `{ "store": "bundle", "ext": ... }` (uploaded here) or `{ "store": "remote", "url": ... }` (already-shared media, referenced only).
- Media objects uploaded with `ContentType` set and **no extra compression** (clips/MP3s are already compressed).
- Uploads/downloads use **presigned URLs** so bytes go browser↔S3 directly and never transit the Next.js server.

### 2. Server (editor's Next.js + Postgres)

The editor already runs `betterAuth` on Postgres (Drizzle ORM). Add **one table**:

```
shared_bundles
  id            uuid pk
  team_id       text            -- v1: a single shared team constant; see Assumptions
  project_name  text            -- "Ep#9"
  stage_label   text null       -- "raw cut" / "final cut"
  author_user_id text           -- from session
  author_name   text            -- denormalized for the list label
  manifest_key  text            -- S3 key of manifest.json
  size_bytes    bigint
  created_at    timestamptz default now()
```

API routes under `apps/web/src/app/api/cloud/`:

| Route | Method | Purpose |
|---|---|---|
| `/api/cloud/bundles` | GET | List team's bundles (newest first) for the panel. |
| `/api/cloud/bundles` | POST | Register a bundle after upload (returns id) **or** issue presigned PUT URLs for manifest + media before upload. |
| `/api/cloud/bundles/:id/download` | GET | Return manifest + presigned GET URLs for its media. |

All routes require an authenticated session and scope by `team_id`.

### 3. Client (editor)

- **Packager** (`Share`): walk the current project's media via the existing storage service; for each `mediaId`, read the OPFS blob (local) or note the remote URL (shared); build `manifest.json`; request presigned PUTs; upload manifest + local media blobs directly to S3; POST to register the bundle.
- **Unpacker** (`Open`): GET the bundle; create a fresh local project id; write each media object into the new project's OPFS dir + IndexedDB metadata (remote-referenced media keeps its URL); write the project JSON into IndexedDB; load it via the existing `loadProject({ id })` path. Reuse the existing migration chain (`CURRENT_PROJECT_VERSION`) so older bundles upgrade on open.
- **Cloud Projects panel**: a sidebar/modal listing bundles with the `author · project · stage · date·time` label and an **Open** button; a **Share** button in the toolbar opens the share dialog.

### Data flow

```
SHARE:  editor → (read OPFS + project JSON) → presigned PUT → S3
                                            → POST /api/cloud/bundles (register row)
OPEN:   editor → GET /api/cloud/bundles → panel list
        editor → GET /api/cloud/bundles/:id/download → manifest + presigned GETs
              → write into local OPFS + IndexedDB → loadProject()
```

---

## Error handling

- **Upload interrupted / partial:** bundle row is only registered **after** all objects upload successfully (register last). A half-uploaded bundle never appears in the list.
- **Quota on open:** reuse the editor's existing `StorageQuotaExceededError` path; if the target machine can't fit the media, surface the same quota message before writing.
- **Remote-referenced media unreachable on open:** surface a per-clip "media missing" state (the editor already tolerates missing media on load) rather than failing the whole open.
- **Auth/team mismatch:** routes 401 without a session, 403 if the bundle's `team_id` doesn't match the caller's team.
- **Version skew:** bundles carry the project `version`; on open, run the existing migration chain. A bundle newer than the opener's build shows a "update the editor to open this" message.

---

## Risks / known trade-offs

- **Large projects in the browser.** v1 uploads every local media file per Share. For multi-GB projects this is slow and memory-heavy. *Mitigation:* upload media as individual objects (not one in-memory `.zip` blob) and stream. *v2 upgrade (same UX):* content-address media by hash so re-Shares only upload changed/new files — turns a GB handoff into "just the new MP3s." Flagged, not built, in v1.
- **No lock = possible fork.** Two people could both open the same bundle and Share divergent versions. Acceptable for a sequential pipeline; immutable snapshots mean nothing is lost. Hard lock is the v2 option if it bites.
- **Team scope is a constant in v1** (see Assumptions). Fine for Andy + Ham + Mike; needs real team wiring before external users.

---

## Assumptions

1. **Single shared team for v1.** All authenticated editor users share one Cloud Projects list (`team_id` = a constant). The editor's `betterAuth` identity is separate from creatorgrowth.com's email-code identity; unifying them is a larger, separate job.
2. **S3 creds available to the editor server** (reuse CG's bucket/creds; bucket is private, presigned URLs only).
3. **Media fidelity = byte-for-byte.** The unpacked project references identical media bytes (or the same remote URLs), so the timeline renders identically on the other machine.

---

## Build checklist (for the implementation plan)

1. `shared_bundles` table + Drizzle migration.
2. S3 helper in editor server (presign PUT/GET, team-prefixed keys) reusing CG creds.
3. API routes: list / register+presign / download.
4. Client packager (Share) + share dialog.
5. Client unpacker (Open) writing into OPFS + IndexedDB, then `loadProject`.
6. Cloud Projects panel UI + Share toolbar button.
7. Error/quota/version-skew handling per above.
8. Manual round-trip test: Share on machine A → Open on machine B → timelines/media identical.
