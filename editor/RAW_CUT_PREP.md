# Prep Doc: Raw Cut mode — silence-cutter inside the OpenCut fork

> Build brief for a TimeBolt-style silence-cutting **mode** in our OpenCut fork
> (`~/dev/creatorgrowth-editor`, served at `creatorgrowth.com/editor`). Written
> 2026-05-29 after mapping the real codebase. **This supersedes the earlier
> `AUTO_EDITOR_PREP.md`, which was wrongly anchored to the dead hand-rolled
> `#editorStudio` editor in the Flask repo (killed 2026-05-15).**
>
> **Paired content doc** (the on-camera video this build is for):
> `Claude Folder/content/content_docs/i_built_a_silence_cutter_into_my_editor.md`
> — master-tab "Raw Cut", series "Claude Code Builds ep #6". The build steps in
> §11 are 1:1 with that doc's 6 steps; keep them in sync if either changes.

---

## 1. What we're building (one line)

A raw-footage **mode** that auto-detects and always cuts silences, shows a
**green=keep / red=cut waveform**, and lets you **scrub once at 1x-1.5x-2x–3x and
keyboard-toggle** which spoken segments survive — turning ~2hr of talking-head
into a ~30min cut. 

### The 3 hard criteria (Andy)
1. **Auto remove silences** — always, automatically, over the original file.
2. **Edit with only keyboard shortcuts** — scrub fast, keep/cut by key.
3. **2hr → 30min** — silences do the first chunk; fast keyboard keep/cut does the rest.

### Reference UI = TimeBolt
Waveform with green(keep)/red(cut) regions; playback rate 1x/2x/3x; chunk pager
for long files; a Silence Detection panel (Filter Below Sound Level dB, Remove
Silences Longer Than, Ignore Detections Shorter Than, Left/Right Padding); a
dedicated **Keyboard Shortcuts** settings menu (see §8 for the exact map).

---

## 2. The key realization: the editor already does ~90% of this

**Raw Cut is a thin feature, not a new engine.** Everything heavy already exists
in the fork (anchors in §12):

| Need | Already in OpenCut |
|---|---|
| Non-destructive cuts | Clips reference `mediaId` with `trimStart`/`trimEnd`/`startTime`/`duration`; source untouched. `lib/timeline/types.ts:107-217` |
| Split / delete / ripple | `timeline-manager` `splitElements()`, `deleteElements()`, `updateElementTrim()`; ripple toggle in `commands.ts`. `split-elements.ts` |
| Undo / redo | `command-manager` history, every edit is a Command. `commands.ts` |
| Audio energy analysis | `extractRmsRange()` + `computeGlobalMaxRms()` over an `AudioBuffer.getChannelData()`. `lib/media/audio.ts:678-735` |
| Waveform rendering | `audio-waveform.tsx:30-197` already paints RMS bars on canvas |
| **Client-side render** | WebCodecs + mediabunny + Rust/WASM (WebGPU) compositor; muxes in-browser, **no server**. `scene-exporter.ts:47-170` |
| Keyboard system | Zustand keybinding store + actions registry + **user-customizable settings UI**. `lib/actions/definitions.ts`, `use-keybindings.ts` |
| "Detect → review → auto-clip" precedent | **Screen-share view** does exactly this for visual scene cuts: `panels/assets/views/screen-share.tsx` (`POST /api/videos/{vid}/screen-share/detect` → boundaries → auto-insert clips on a lane). **Raw Cut is its audio twin.** |
| Browser-local storage | media in OPFS, project in IndexedDB; Postgres = auth only. `opfs-adapter.ts` |

**What's genuinely new:** (a) silence detection over the audio (extend RMS),
(b) the Raw Cut view (green/red waveform + detection knobs + chunk pager),
(c) the keep/cut keyboard scheme + actions, (d) 2x/3x playback rate (not yet
supported), (e) the DaVinci-style mode switch.

---

## 3. Locked decisions (reconciled with the real editor)

| Decision | Choice | Why |
|---|---|---|
| **Where it's built** | Inside the OpenCut fork (`apps/web/src/…`), **not** the dead Flask `#editorStudio`. | The Flask overlay was killed 2026-05-15 (memory `creatorgrowth-editor-opencut`). |
| **Silence engine** | **Client-side RMS threshold** over the decoded `AudioBuffer` — extend `extractRmsRange()`. NOT ffmpeg `silencedetect`. | The editor decodes audio to PCM client-side already; RMS dB-thresholding is the same energy approach as silencedetect, with zero new infra. TimeBolt knobs still map 1:1 (§5). |
| **Edit paradigm** | Green/red waveform keep-cut (TimeBolt), extend `audio-waveform.tsx`. Not transcript-based. | Matches the reference; reuses existing waveform code. |
| **Raw Cut ↔ Edit relationship** | **Same shared timeline, different mode/view.** Raw Cut is a specialized interaction layer over the *same clips* Edit mode uses. Cuts = timeline edits (split + disable clips). | Andy: "separate but seamless… all inside the capcut." It's seamless *because* they share one timeline — no project hand-off, no copy. |
| **Non-destructive / no render** | **Raw Cut never renders.** A "cut" = a clip marked **disabled/muted** (not deleted), still holding its `trimStart/trimEnd`. In Edit mode you **re-enable / drag it back**. The single render is the editor's existing WebCodecs export. | Andy: "in Raw Cut we never actually render… we still need the cuts intact so we can drag that part back out — nothing is really missed." The clip model already supports `muted`/`hidden`. |
| **Multi-tenant** | **Already solved — it's all client-side.** Each user's browser does detect + edit + render via WASM/WebCodecs over OPFS-local media. No AWS render. Paid gating lives at auth (better-auth + Skool allowlist). | The fork is client-side by design. The earlier AWS-render plan was based on the dead server-render editor and is **moot.** |
| **Cloud (only open piece)** | The *finished export* may be uploaded to cloud storage for cross-device playback / the publish pipeline — the existing plan POSTs the WebCodecs MP4 to Flask. S3 vs Flask/NAS is a **storage** choice, not a render one. | "Goes to cloud, seamless playback" = store the small finished cut, not render it remotely. (§10) |

---

## 4. Architecture

### 4a. Raw Cut as a mode over the shared timeline
The editor today is a fixed layout: Assets panel (left) · Preview (center) ·
Properties (right) · Timeline (bottom) (`app/editor/[project_id]/page.tsx:70-142`).
There is **no global mode concept** yet.

**Target (Andy's ask): a DaVinci-style mode bar** that switches the editor between:
- **Raw Cut** — the silence cutter (green/red waveform, fast keyboard keep/cut).
- **Edit** — today's full timeline/compositor editor (unchanged).

Both modes act on the **same scene/timeline/clips**. Raw Cut just swaps the work
surface + the active keymap + the playback behavior. Flipping to Edit shows the
same clips — kept ones active, cut ones disabled/recoverable.

**Pragmatic path:**
- **v1 (fast):** ship Raw Cut as an Assets-panel **view/tab** (clone the
  screen-share view's structure, `panels/assets/index.tsx:19-39`) so it lands
  without re-architecting the layout. Prove the cut loopt.
- **v1.5 (the real ask):** promote it to a **top-level mode switcher** (DaVinci
  bottom bar) — a `useEditorModeStore` (Zustand) that conditionally renders the
  Raw Cut surface vs the standard panels. This is the only structural change.

### 4b. Data flow (all client-side, single render at the end)
```
local file → media bin (OPFS)            [processMediaAssets, existing]
   │
   ├─ decode audio → AudioBuffer          [lib/media/audio.ts, existing]
   ├─ RMS silence detect (dB threshold)   [NEW: extend extractRmsRange]
   │     → keep/cut ranges
   ├─ apply ranges to timeline:           [splitElements + disable, existing cmds]
   │     keep = active clip, cut = disabled/muted clip (recoverable)
   ├─ scrub 2x/3x + keyboard keep/cut      [NEW playback rate + actions]
   │     → flips clip.enabled, re-splits, all undoable
   │
   └─ flip to EDIT (same clips) → existing WebCodecs EXPORT (the ONLY render)
         → finished ~30min MP4, in-browser → (optional) upload to cloud
```

---

## 5. Silence engine (client-side RMS — reuse what's there)

The waveform already computes RMS peaks per bin. Silence detection is a threshold
pass on the same data — no ffmpeg, no server.

### 5a. Detect
- Decode the clip's audio to `AudioBuffer` (existing `resolveAudioBufferForElement`
  / `resolveAudioBufferForVideoElement`, `audio.ts:213-327`).
- Walk samples (`getChannelData()`), compute short-window RMS in dB.
- A window below the dB threshold for ≥ "min silence" duration = a **silence
  interval**. Invert → **keep ranges**.
- (Reuse `extractRmsRange`/`computeGlobalMaxRms` shapes; add `computeSilenceRanges()`
  in `lib/media/audio.ts` next to them.)

### 5b. TimeBolt knobs → params (still 1:1, just RMS not ffmpeg)
| Reference field | Maps to | Default |
|---|---|---|
| Filter Below Sound Level (dB) | RMS dB threshold | −43 dB |
| Remove Silences Longer Than (s) | min silence duration to cut | 0.75 |
| Ignore Detections Shorter Than (s) | drop keep-segments shorter than this; merge | 0.75 |
| Left Padding (s) | extend each keep range's start earlier | 0.01 |
| Right Padding (s) | extend each keep range's end later | 0.15 |
| UPDATE SILENCE DETECTION | re-run pass, recompute clips | — |

### 5c. Apply to timeline
Convert keep ranges → clips via `splitElements()` at each boundary, then mark the
silence clips **disabled/muted** (recoverable) rather than `deleteElements()`.
With ripple on, kept clips close the gaps. All steps are Commands → undoable.

---

## 5B. Repeated-take detection — the BLUE layer (suggestion, not decision)

Three-color model on the waveform:
- 🟢 **Green** = keep (spoken).
- 🔴 **Red** = silence → **auto-cut**, high confidence (RMS, §5).
- 🔵 **Blue** = "looks like you said this already" → **suggested cut**, *user confirms*.

Blue is the "edits out dead takes" feature. It is explicitly a **suggestion**, never
an automatic removal — the tool points at the redundant take, you accept/reject.
This keeps the on-camera claim honest (it surfaces repeats; you decide).

### How it works (needs a transcript — different engine than red)
Red is free (audio energy). Blue needs to read the **words**:
1. **Transcribe** the spoken (green) regions → segment text + timestamps. Source:
   Whisper (Replicate `incredibly-fast-whisper`, already used on the Flask side),
   ElevenLabs, or the OpenCut **captions** view if it already transcribes.
2. **Compare nearby spoken segments** for near-duplicate text (normalized n-gram
   overlap or embedding cosine). When consecutive segments are near-identical
   (you flubbed and re-did the line), flag the **earlier** take(s) blue.
3. **Default heuristic:** keep the LAST take (usually the clean one), suggest
   cutting the earlier repeats. Tunable similarity threshold.
4. **Accept model:** blue clips are *not* disabled until confirmed. A keypress
   accepts the current blue suggestion (→ becomes a red/disabled cut), or steps to
   the next, or accept-all. Rejecting turns it green.

### Why it's its own build step
Red/green silence ships fast with zero transcript. Blue pulls in transcription +
text-similarity — a meaningfully bigger lift and a distinct on-camera "whoa" beat
("…it even caught where I re-recorded the same line"). Keep it a separate step;
don't cram it into the silence pass.

### Open sub-questions
- Transcript source: reuse Replicate Whisper vs ElevenLabs vs OpenCut captions?
  (Check whether the fork's `captions` view already produces a transcript.)
- Similarity method: n-gram Jaccard (cheap, good enough) vs sentence embeddings
  (better on paraphrased retakes, heavier).
- Scope of comparison: only adjacent segments (fast, catches immediate retakes) vs
  whole-clip (catches scattered repeats, O(n²) — cap it).

---

## 6. Non-destructive cuts (criterion: "nothing is missed")

- A "cut" never deletes media or the clip — it sets the clip **disabled** (and/or
  `muted`), keeping its `trimStart/trimEnd`. Silences are auto-disabled (red).
- In Edit mode the disabled clips are visible/recoverable — **re-enable or drag
  back** to restore anything Raw Cut over-cut.
- The clip model already carries `muted`/`hidden`; add an `enabled`/`disabled`
  notion if not present (small extension to `lib/timeline/types.ts`), and have
  the renderer + export skip disabled clips.

---

## 7. Playback rate 2x/3x (the one playback gap)

`playback-manager` exposes play/pause/seek/volume but **no playback rate**
(`playback-manager.ts:165-206`). Add it:
- Track `playbackRate` in the manager; scale elapsed time in the `updateTime()`
  loop by the rate.
- Wire the JKL shuttle (`L` increases speed each press) + `1/2/3` direct rates.
- Frame-step actions already exist (`use-editor-actions.ts:105-134`) for `J`/`→`.

---

## 8. Keyboard scheme — LOCKED (TimeBolt) + its own settings menu

Add these as **actions** in `lib/actions/definitions.ts`, bind handlers via
`useActionHandler()` in `hooks/actions/use-editor-actions.ts`, and register
default shortcuts. **The user-customizable Keyboard Shortcuts settings UI already
exists** (keybindings store + settings view) — Raw Cut actions appear there for
free; just group them.

**Core**: `Space` play/pause · `S` split.
**Cut status**: `O` cycle cut status at playhead (turning off advances playhead to
next cut) · `B` turn off previous green cut · `Shift+O` turn off current + all next
green cuts (stops at a Locked cut) · `Shift+B` turn off all previous (stops at
Locked) · `M` mark/unmark cut · `H` lock cut.
**Navigate cuts**: `↑` next cut (any) · `↓` prev cut · `Shift+↑` next green cut ·
`Shift+↓` prev green cut · `U` unwind (prev green cut ×3).
**Frame step**: `←`/`→` ∓1 frame · `Shift+←`/`Shift+→` ∓10 frames.
**JKL shuttle**: `J` prev frame · `Shift+J` prev ×10 · `K` pause · `L` play
(increase speed each press: 1x→2x→3x…).
**Punch-in**: `P` punch in 25% · `Alt + [↑↓←→]` change punch position. *(Mark only
in Raw Cut; applied at export via the clip transform.)*
**Timeline**: `Cmd/Ctrl+Z` undo · `Cmd/Ctrl+S` save cuts (.json).

**Concepts to model** (mostly map onto existing clip state):
- **Green cut** = a kept clip (enabled). "Turn off" = disable it (recoverable). Silences = always disabled/red.
- **Cut status cycle (`O`)** = toggle enabled→disabled on the clip at the playhead, then auto-seek to the next boundary → the fast one-pass review.
- **Locked cut (`H`)** = a flag on the clip; bulk sweeps (`Shift+O`/`Shift+B`) stop at the first locked clip. (New boolean on the clip or a side set.)
- **Save Cuts (.json)** = serialize the keep/cut/lock state; also rides the
  existing auto-save (IndexedDB) so it's durable without a manual save.
- **Punch-in** = a transform marker on the clip, applied by the existing
  compositor at render (Raw Cut never renders).

Design intent: hold `L` to shuttle up to 2x/3x, tap `O` to drop dead/bad segments
(playhead jumps to the next), `H` to lock keepers, `Shift+O` to sweep the rest.
No mouse.

---

## 9. Render — ride the existing WebCodecs export (no AWS)

The editor already exports 100% in-browser: `export-button.tsx:95-141` →
`renderer-manager.exportProject()` (`:141-230`) → `SceneExporter` muxes via
mediabunny + WebCodecs + the WASM/WebGPU compositor (`scene-exporter.ts:47-170`).
H.264/AAC for MP4, quality picker, no server POST.

For Raw Cut there is **nothing new to build here** — disabled clips are skipped,
kept clips render in order. The export already trims (`trimStart/trimEnd`) and
composes. Punch-in transforms apply through the same compositor.

> Caveat: the export frame-loop buffers the whole output and isn't chunked
> (`scene-exporter.ts:136-149`) — fine for a ~30min cut, but watch memory on very
> long outputs. Not a Raw Cut concern (Raw Cut shrinks the output). Flag if export
> of long results OOMs; chunked muxing is a separate optimization.

---

## 10. Multi-tenant (already solved) + the only cloud question

**It works for other users day one because it's all client-side:** detection,
editing, and render run in each user's browser (WASM/WebCodecs) over OPFS-local
media; Postgres is auth-only. Unlimited concurrent users, zero render infra, no
big-upload. Paid gating = the existing auth (better-auth + Skool-handle allowlist,
memory `creatorgrowth_skool_auth`).

**The one open cloud decision — storage of the *finished* export**, not render:
- Today's plan POSTs the exported MP4 to Flask for the YouTube publish pipeline
  (memory: OpenCut Phase 3).
- If Andy wants finished cuts stored/served for cross-device playback, that's an
  **S3 (or existing NAS/Flask) storage** decision — small files, no compute.
- The raw 2hr source stays in the user's browser (OPFS); it never needs to upload.

So: AWS, *if used at all*, is just object storage for results — not the Fargate
render farm the old doc described.

---

## 11. Build steps — 1:1 with the content/prep doc

**These are aligned to the on-camera steps** in the content doc
(`Claude Folder/content/content_docs/i_built_a_silence_cutter_into_my_editor.md`,
master-tab "Raw Cut", series "Claude Code Builds ep #6"). Filming Step N = building
Step N. Each step ends on a visible "it works" beat.

**Step 1 — Build the Raw Cut page.**
Upload already works (drag clip → media bin via `processMediaAssets()`). New work =
the page + entry point: new `panels/assets/views/raw-cut.tsx` (clone
`screen-share.tsx`), reachable via right-click asset → "Open in Raw Cut" OR a bottom
mode button; you pick which asset to cut. Done = the page opens with the clip loaded.

**Step 2 — Upload and analyze (green/red).**
Decode audio → `computeSilenceRanges()` (§5) → paint 🟢 keep / 🔴 silence across the
whole timeline; scrub + preview. Wire the 5 detection knobs + UPDATE. Time it on a
real 2hr file (the proof). Done = green/red on the full clip right away.

**Step 3 — Detect double takes (blue) (§5B).**
Transcribe spoken regions, compare nearby segments for near-duplicate text, flag the
earlier take(s) 🔵 **blue** as *suggested* cuts (never auto-removed). Done = repeats
light up blue; one key accepts (→ disabled cut), one rejects (→ green).

**Step 4 — Add keyboard shortcuts (full TimeBolt scheme, §8).**
Actions in `lib/actions/definitions.ts` + handlers in `use-editor-actions.ts`;
extend `playback-manager` for 2x/3x (`L` shuttle). Cut-status sweeps + playhead
auto-advance, lock, mark, unwind, accept/reject blue. Done = every shortcut works
AND is customizable in settings, scoped to Raw Cut.

**Step 5 — Export cuts into editor.**
Non-destructive apply: `splitElements()` at boundaries; cut clips → disabled
(recoverable), not deleted (add `enabled`/`locked` to `lib/timeline/types.ts` if
missing; renderer + export skip disabled). Flip to Edit mode (same timeline — the
DaVinci-style `useEditorModeStore` mode switch) and drag any red/blue clip back.
Render rides the existing in-browser WebCodecs export (§9). Done = a clean cut in
the editor, nothing lost.

**Step 6 — Bonus: tease + open source.**
Tease next: auto-detect chapters → auto chapter markers + sound effect; tease the
Diagrams/Chapters studio + auto-thumbnail. CTA funnel (Andy's call): coders → public
GitHub (don't fake-private an MIT fork); non-coders → Skool gets the easy install +
setup first; everyone → hosted `creatorgrowth.com` "launching soon."

> **Later / off-camera (not a filmed step):** FastForward-silences + transitions
> (TimeBolt extras), punch-in render, and cloud storage of finished exports for the
> publish pipeline.

---

## 12. Integration anchors (real, in `~/dev/creatorgrowth-editor`)

| What | Where |
|---|---|
| EditorCore manager composition | `apps/web/src/core/index.ts:17-76` |
| `useEditor()` hook | `apps/web/src/hooks/use-editor.ts:13-60` |
| Clip / track types (`trimStart/trimEnd`, `muted`, `retime`) | `apps/web/src/lib/timeline/types.ts:107-217`, `:29-80` |
| split / delete / trim commands | `timeline-manager.ts`; `lib/commands/timeline/element/split-elements.ts` |
| undo/redo + ripple toggle | `core/managers/commands.ts` |
| **RMS / silence math (extend here)** | `apps/web/src/lib/media/audio.ts:678-735` (`extractRmsRange`, `computeGlobalMaxRms`) |
| audio decode to AudioBuffer | `lib/media/audio.ts:213-327` |
| **waveform component (extend for green/red)** | `apps/web/src/components/editor/panels/timeline/audio-waveform.tsx:30-197` |
| keybinding store (Zustand, persisted) | `keybindings-store.ts:49-150` |
| action definitions (add Raw Cut actions) | `apps/web/src/lib/actions/definitions.ts` |
| default shortcuts | `apps/web/src/lib/actions/index.ts` (`getDefaultShortcuts`) |
| keydown dispatch | `hooks/use-keybindings.ts:12-87`; action registry `bindAction`/`invokeAction` |
| action handlers (bind Raw Cut handlers) | `hooks/actions/use-editor-actions.ts:60-200` (frame-step `:105-134`) |
| **playback (add 2x/3x rate)** | `core/managers/playback-manager.ts:165-206` |
| editor layout (mode bar goes here) | `apps/web/src/app/editor/[project_id]/page.tsx:70-142` |
| assets panel tabs (v1 view slot) | `apps/web/src/components/editor/panels/assets/index.tsx:19-39` |
| **"detect → review → auto-clip" precedent** | `apps/web/src/components/editor/panels/assets/views/screen-share.tsx` |
| export UI + client-side render | `components/editor/export-button.tsx:95-141`; `core/managers/renderer-manager.ts:141-230`; `services/renderer/scene-exporter.ts:47-170` |
| WASM/WebGPU compositor | `services/renderer/canvas-renderer.ts:71-83`; `rust/wasm/src/compositor.rs:24-152` |
| OPFS / IndexedDB storage | `services/storage/opfs-adapter.ts:1-74` |
| creatorgrowth bridge + ingest | `app/from-card/page.tsx:37-77`; `lib/media/processing.ts:172-297` |

---

## 13. Open questions

1. **Disabled-clip support:** does a clip already have an enable/disable concept,
   or do we add `enabled` to `lib/timeline/types.ts` + teach renderer/export to
   skip it? (Likely a small add.) Check before Phase 1.
2. **Mode bar vs panel tab for v1:** ship as an Assets tab first (fast) and
   promote to a real mode in Phase 3 — confirm Andy's OK starting as a tab.
3. **Detection cost on 2hr in-browser:** decoding 2hr audio is RAM-heavy — decode
   per-clip / downsample / chunk (also why the chunk pager exists). Validate on a
   real 2hr file; if too heavy, decode at reduced sample rate for the envelope.
4. **Cloud storage of finished exports:** S3 vs existing Flask/NAS POST — storage
   only, decide if/when we wire cross-device playback (§10).
5. **Locked-cut storage:** new boolean on the clip vs a side set keyed by clip id.

---

## 14. Do-nots

- **Don't build in the Flask `creatorgrowth` repo / `#editorStudio`.** That editor
  is dead. All work is in `~/dev/creatorgrowth-editor` (the OpenCut fork).
- **Don't render in Raw Cut.** Cuts are clip-state changes only. The single render
  is the existing WebCodecs export.
- **Don't delete cut clips.** Disable them (recoverable) — "nothing is missed."
- **Don't add a server render / AWS Fargate.** The editor renders client-side;
  that plan was based on the dead server-render editor.
- **Don't reinvent split/trim/undo/waveform** — extend the existing managers and
  `audio.ts`/`audio-waveform.tsx`. Reuse > rebuild (this is why we forked OpenCut).
- **Pin `opencut-wasm` exactly** (`0.2.8`) — version drift black-canvases the
  renderer (cost ~2h once already; memory note May 19).
- Respect the keybinding **store migration** pattern when adding default shortcuts
  (Zustand persist version bump), so existing users get the new binds.

---

## 15. Start cue (for the builder)

1. `cd ~/dev/creatorgrowth-editor`, run it locally, open a project, confirm a clip
   imports + the existing waveform + export work (baseline).
2. **Read `screen-share.tsx` end-to-end** — it's the exact "detect → review →
   auto-clip" pattern Raw Cut copies (just audio-silence instead of visual scenes,
   and client-side instead of a Flask call).
3. Build **Phase 0** (`raw-cut.tsx` view + `computeSilenceRanges()` + green/red
   waveform) and get Andy to eyeball detection accuracy on a real 2hr file before
   wiring the keyboard cut loop.
