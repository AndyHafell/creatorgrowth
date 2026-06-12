# Magic Zoom Layer — adjustment-layer track for zoom / highlight — v2 Design

**Date:** 2026-06-11 (v2 — updated with Andy's checkpoint answers, same day)
**Author:** Claude (HyperEdit lane) for Andy
**Status:** Approved direction — building MVP
**Repo:** `creatorgrowth-editor` (OpenCut fork, Next.js + Rust/WASM compositor, VPS)
**Branch:** `motion-graphics-judged`

> Naming locked by Andy: the family is the **Magic Zoom layer**. Tools inside it:
> **Magic Zoom** (zoom in/out or continuous) and **Magic Highlighter** (pop-out
> cutout). "HyperEdit" survives only as the internal lane name.

---

## Problem

Andy's words: *"Many times throughout the video I don't know where to look because
we're filming so much stuff. I want some sort of HyperFrames-powered editor that
auto zooms in on the exact things that we're talking about. Think of it like a
LAYER on top of the timeline — almost like an adjustment layer."*

Checkpoint refinement: *"Rather than one layer that goes above the whole thing,
think about it like multiple adjustment layer clips that go on top of the full
video. We want to zoom in at minute one — we just drag an adjustment layer on top
of that."*

**MVP (phase 1):** Magic Zoom + Magic Highlighter clips, manual, working in
preview AND export. **Phase 2:** auto-generate those clips from transcript +
frame analysis. **Phase 3 (designed-for, NOT built):** motion-graphics overlays
(write-on text, chapter animations) via HyperFrames-rendered assets.

## Recon: what already exists (this is mostly an assembly job)

1. **An effect track type exists.** `TrackType = "effect"`, `EffectTrack` +
   `EffectElement { effectType, params }` — `apps/web/src/lib/timeline/types.ts:61-65,199-203`.
2. **Timeline UI already handles effect clips.** The assets panel "Effects" view
   places effect elements onto an effect track (auto placement + drag), they
   render, drag and trim on the timeline (`timeline-element.tsx:945,1179`), and
   the properties panel auto-generates controls from `ParamDefinition[]`
   (`properties/registry.tsx:300`).
3. **Adjustment-layer semantics exist in the compositor.** `EffectLayerNode`
   emits a `SceneEffect` frame item whose shader passes apply to **the composite
   of everything rendered below it** (`frame-descriptor.ts` → Rust
   `compositor.rs:330`).
4. **Effects are a registry.** One definition today (blur):
   `apps/web/src/lib/effects/definitions/blur.ts`; Rust shader registry in
   `rust/crates/effects/src/pipeline.rs` (gaussian-blur shipped).
5. **Time-varying params already resolve per-frame.**
   `resolveEffectParamsAtTime` (`@/lib/animation/effect-param-channel`) runs in
   `resolve.ts`; full keyframe infra (bezier easing) exists in `lib/animation/`.
6. **Preview and export share one render path.** Both go
   `buildScene → resolve → buildFrameDescriptor → wasmCompositor.render`; export
   feeds the same canvas into mediabunny (`scene-exporter.ts`).
7. **Masks + dim quads are primitives.** `LayerDescriptor.mask`
   (`LayerMaskDescriptor { textureId, feather, inverted }`) + canvas-generated
   textures already flow through the descriptor builder (background view does
   this) — enough to build the Highlighter cutout with no new shaders.

### HyperFrames: what it is and what it is not

HyperFrames (`heygen-com/hyperframes`, npm `hyperframes@0.6.46`) is HeyGen's
HTML→video framework: declarative HTML + GSAP timelines rendered deterministically
in headless Chrome, encoded with FFmpeg. Already vendored in this repo —
`motion/compositions/` + the `/motion` route with the Gemini visual-judge loop
(commit `4cfc23e6`, doc at `overnight/motion_design.md`).

It has **no screen-recording, auto-zoom, or footage-camera features** (verified
against the GitHub docs), and it renders server-side while the editor composites
client-side in WASM. **Conclusion:** HyperFrames is the *phase-3 overlay engine*
(MP4 overlay assets onto a normal video track, reusing the judge loop); the
Magic Zoom layer is native compositor work.

## Architecture: camera transforms + composite re-emission. Zero Rust changes.

**Magic Zoom = a camera transform at resolve time.** A zoom clip resolves to a
**camera** (scale + translate around a focal point) instead of shader passes.
During `resolve`, the active camera at time *t* multiplies into the resolved
transform of every visual node on tracks **below** the clip (confirmed by Andy:
below-only — captions/text above stay pinned). The GPU samples *source textures*
at the zoomed density, so screen recordings stay sharp — unlike a UV-remap
shader on the composited 1080p canvas, which would go soft at 2×.

**Magic Highlighter = built from existing primitives**, all emitted by the
frame-descriptor builder when a highlighter clip is active:
1. The scene below renders as normal, then gets a `sceneEffect` blur (existing
   gaussian-blur passes) — the de-focused background.
2. A full-canvas black quad (canvas-generated texture) at `dim` opacity.
3. The lower-track layers **re-emitted once more** with a second camera that
   maps the selected region to a centered, enlarged box, clipped by a
   canvas-generated rounded-rect mask (`LayerMaskDescriptor`, feather for soft
   edge) — the cutout.

No new WGSL, no WASM rebuild, for either tool. (My v1 spotlight.wgsl idea is
dropped — the cutout design is strictly better and cheaper.)

**Overlap rule (MVP):** if two camera clips overlap at *t*, last-on-top wins.

**Edge clamping:** at scale *s* the visible window is `1/s` of the frame; camera
translation clamps so the window never leaves the frame. Pure function,
unit-tested.

## Data model

No new track type. New effect definitions in `lib/effects/definitions/`.
`EffectDefinition` gains `kind: "passes" | "camera" | "highlight"`;
`ResolvedEffectLayerNodeState` grows optional resolved `camera` / `highlight`
state alongside `passes`.

```ts
interface Camera { scale: number; focalX: number; focalY: number } // focal in 0–1 frame space
```

### `magic-zoom`

| param | type | default | notes |
|---|---|---|---|
| `mode` | select: in-out / continuous | in-out | Andy's toggle |
| `scale` | number 1–4, step 0.05 | 1.8 | target zoom level |
| `focalX` / `focalY` | number 0–100 (%) | 50 | zoom-toward point |
| `easeIn` / `easeOut` | number 0–3 s | 0.5 | ramp at clip start/end (in-out mode) |
| `ease` | select: smooth / snappy / linear | smooth | smooth = cubic in-out |
| `direction` | select: in / out | in | continuous mode only |

**in-out mode** (the "zoom in at minute one" case): identity → ease quickly to
`scale` over `easeIn` → hold → ease back over `easeOut` ending at the clip's
end. In/out points = the clip's edges; trimming the clip retimes the move.

**continuous mode**: one steady ramp across the whole clip — scale 1→`scale`
(direction=in) or `scale`→1 (direction=out), eased per `ease`. A slow push-in.

Envelope is computed from clip-local time in the resolver — no keyframing needed
for the 95% case; the keyframe system can layer on later.

### `magic-highlight`

| param | type | default | notes |
|---|---|---|---|
| `regionX/Y/W/H` | number 0–100 (%) | 25/25/50/50 | selected screen region |
| `size` | number 20–100 (%) | 65 | how much of the frame the cutout fills |
| `transition` | number 0–2 s | 0.5 | pop-in/pop-out duration |
| `dim` | number 0–100 | 70 | background darkening |
| `blur` | number 0–100 | 25 | background blur intensity |
| `cornerRadius` | number 0–48 px | 12 | cutout rounding |

Behavior: over `transition` seconds the selected region pops from its in-place
position/scale to a centered cutout filling `size`% of the frame while the
background dims + blurs in; holds; reverses over `transition` at the clip's end.
Andy: more highlighter features will come — params stay a flat bag so additions
are cheap.

## Preview overlay (in MVP — Andy asked twice)

When a Magic Zoom / Magic Highlighter clip is selected, the preview panel shows
an interactive overlay: a draggable/resizable region rectangle (for zoom: the
area to zoom into → writes `focalX/focalY` + derives `scale` so the region fills
the frame; for highlighter: writes `regionX/Y/W/H`). Sliders in the properties
panel remain the precise fallback and stay two-way in sync. Implementation:
absolutely-positioned div overlay on the preview container mapping pointer
coords → frame %, no canvas hit-testing needed.

## Render path changes

1. `resolve.ts`: resolve effect-track elements; active camera composes into
   lower-track visual nodes' resolved transforms; active highlight resolves its
   envelope state (progress 0→1) for the descriptor builder.
2. `frame-descriptor.ts`: highlight emits blur `sceneEffect` + dim quad +
   re-emitted masked cutout layers (see Architecture). Zoom needs no structural
   change here (transforms already flow through `QuadTransformDescriptor`).
3. Scope rule: clips affect only tracks **below** them (locked by Andy).
4. Export: zero extra work (shared path) — verified by an export test.

## UI

- Assets panel gains a **Magic Zoom** section listing **Magic Zoom** and
  **Magic Highlighter** cards. Existing drag-to-timeline/click-to-add placement
  onto an effect track ("drag it on top of that minute of video").
- Properties panel renders params automatically from the definitions.
- Preview overlay as above.
- Timeline clip body shows tool name + badge (e.g. "Magic Zoom 1.8×").

## Phase 2 — auto-zoom (design only, unchanged from v1)

Auto generates the same artifacts manual editing uses: a JSON plan
`{ clips: [{ start, end, scale, focalX, focalY, easeIn, easeOut, reason }] }`
inserted as ordinary editable clips (mirrors Raw Cut's import-cuts pattern).
Signals, in priority order: transcript beats (Raw Cut already has word-level
timings) → Gemini vision pass on sampled frames (pattern + budget guard exist in
`lib/motion/judge.ts`) → cursor/click frame differencing.

## Phase 3 — motion-graphics overlays (design only, unchanged from v1)

HyperFrames compositions render to MP4 server-side via the existing `/motion`
pipeline (+ judge loop) and import as normal video elements on a track above.
Write-on word highlights sync via transcript timings passed as composition
variables. No new timeline mechanism.

## Testing

- TDD pure functions: zoom envelope (`localTime → scale`, both modes), camera
  clamping/composition, highlight envelope, region→camera math for the cutout,
  overlay coord mapping. `bun test`, colocated like existing timeline tests.
- One export integration check: tiny project + zoom clip → export → sampled
  frame differs from unzoomed render.
- Known pre-existing failures to ignore: `detection-knobs.tsx` a11y lint;
  `opencut-wasm` load failure under `bun test`.

## Files to touch (MVP)

- `apps/web/src/lib/effects/definitions/magic-zoom.ts`, `magic-highlight.ts`
  (new) + `definitions/index.ts`, `registry.ts`, `types.ts` (kind)
- `apps/web/src/lib/effects/camera.ts` (new — envelope + clamp math, pure)
- `apps/web/src/services/renderer/resolve.ts`, `nodes/effect-layer-node.ts`,
  `compositor/frame-descriptor.ts`
- `apps/web/src/components/editor/panels/assets/views/effects.tsx` (Magic Zoom
  section), preview overlay component (new), timeline clip label tweak
- Tests next to each

**Not touched (other agent's lane today):** `lib/raw-cut/`,
`app/api/final-pass/`, `components/editor/raw-cut/`,
`components/editor/final-pass/`.

## Out of scope for v1

- Auto-zoom (phase 2) and HyperFrames overlays (phase 3) — designed above.
- Keyframed camera curves UI (envelope params cover MVP).
- Cursor-following zoom, click rings, multi-camera blend rules, additional
  highlighter features Andy has queued ("we will have some more features").

## Checkpoint answers (Andy, 2026-06-11)

1. Zoom affects only tracks below the clip — **confirmed**.
2. Focal point: % sliders **plus** an interactive region overlay on the
   previewer — overlay is in MVP.
3. Multiple independent adjustment-layer clips, dragged onto any time range —
   confirmed (matches effect-track model).
4. Naming locked: **Magic Zoom** (layer + zoom tool), **Magic Highlighter**.
5. Zoom modes: in-out (quick in, hold, out — timed by clip edges) AND
   continuous (steady push, in or out).
6. Highlighter is a pop-to-center cutout over a dimmed + blurred background,
   ~0.5s transition — not a dim-outside spotlight.
