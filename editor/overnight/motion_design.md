# /motion — Motion graphics with AI visual judge

Branch: `motion-graphics-judged`. Pushed, not merged.

A self-iterating motion-graphics pipeline. The user submits text (and optionally a logo) plus a style preset. The system renders a 10s MP4 with Hyperframes, samples 5 frames, sends them to Gemini 2.5 Flash for a rubric score, and — if any axis scores below 7 — adjusts composition parameters and re-renders. Up to 3 iterations per request.

## Layers

### 1. Composition layer — `motion/compositions/<preset>/index.html`

One Hyperframes project per preset. Each is a self-contained 1920×1080, 10-second composition:

- Declares its variables on `<html data-composition-variables=…>` (text, optional logoUrl, plus tunable params: `fontSize`, `entryEase`, `entryDuration`, `stagger`).
- Reads them with `window.__hyperframes.getVariables()`.
- Builds a single GSAP timeline, registered as `window.__timelines["<preset>"]`, paused.
- Uses `data-layout-allow-overflow` where intentional (entry slides).

Five presets:

| Preset            | Hero                                | Notes                                                          |
| ----------------- | ----------------------------------- | -------------------------------------------------------------- |
| `typewriter-dark` | Monospace text writes on, dark bg   | Char-by-char reveal via `clip-path` sweep + caret blink        |
| `slide-bold`      | Words slide in stacked, heavy sans  | Per-word stagger, x/y entry, big y-offset exits cancelled      |
| `glow-neon`       | Text fades in with neon glow + pulse| `text-shadow` layered, subtle scale pulse loop (finite repeat) |
| `logo-reveal`     | SVG draw-on then fill               | `stroke-dasharray` 0→len → opacity fill-in                     |
| `multi-logo-grid` | 2–6 logos stagger into grid         | CSS grid, scale-bounce entries with `back.out`                 |

### 2. Render layer — `apps/web/src/lib/motion/renderer.ts`

Wraps `npx hyperframes` calls:

1. Build a temp project: copy `motion/compositions/<preset>/` to `renders/<id>/`.
2. Write `vars.json` with the resolved variables (user text + tuned params).
3. Run `npx hyperframes lint .` — abort + log on failure (no render, no judge).
4. Run `npx hyperframes render --variables-file vars.json --output <id>.mp4 --quality draft --workers 1`.
5. Verify with `ffprobe` — codec h264, 9.5≤duration≤10.5s, 1920×1080, 30fps.
6. On accepted final, optionally re-render at `--quality high`.

`--quality draft` for iteration. Final passing render uses `--quality high`. `--workers 1` because of macOS memory pressure (24GB total, often <1GB free per `hyperframes doctor`).

### 3. Eval layer — `apps/web/src/lib/motion/judge.ts`

For each rendered MP4:

1. `ffmpeg -i <mp4> -vf "select='eq(n,0)+eq(n,75)+eq(n,150)+eq(n,225)+eq(n,300)'" -vsync vfr frames/<hash>/%d.png` extracts frames at t = 0, 2.5, 5, 7.5, 10s (30fps).
2. SHA-256 of the MP4 keys a JSON cache (`renders/.judge_cache.json`) — a re-judge of the same bytes is a free hit.
3. Otherwise, one Gemini `gemini-2.5-flash` call with all 5 frames inline (`inlineData` base64 PNG parts) + the rubric prompt. `responseMimeType: application/json`, `temperature: 0.1` for stability.
4. Parses the JSON, validates shape (4 numeric axes 0–10 + `issues[]`).
5. Appends `{ promptTokens, candidatesTokens, totalTokens, dollarSpend }` to `overnight/motion_render.log` per call (Gemini 2.5 Flash pricing: $0.30/M input, $2.50/M output as of 2026-01 — adjust if pricing changes).
6. Aborts the loop and surfaces the partial result if cumulative spend exceeds $0.90 of the $1.00 cap.

Rubric prompt:

```
You are evaluating a motion graphics video. Five frames from t=0, 2.5, 5, 7.5, 10s.
Score 0-10 on each dimension. Return ONLY valid JSON, no prose:
{
  "readable": <0-10, is text/logo clearly visible in every frame>,
  "professional": <0-10, does it look polished vs janky/amateur>,
  "timing": <0-10, does the animation progress feel right across frames - not too fast, not stuck, not ending early>,
  "smoothness": <0-10, do consecutive frames suggest smooth motion vs jumpy/broken>,
  "issues": [<short strings: specific fixable problems, e.g. "text cut off right edge at t=5", "logo barely visible at t=0">]
}
```

Passing bar: every axis ≥ 7.

### 4. Iteration layer — `apps/web/src/lib/motion/iterate.ts`

Reads `issues[]` from the judge result and mutates the params object. Each rule is keyword-match on the issue string (case-insensitive):

| Issue keyword                          | Param mutation                                       |
| -------------------------------------- | ---------------------------------------------------- |
| `cut off`, `edge`, `overflow`, `clip`  | `fontSize *= 0.9`                                    |
| `barely visible`, `invisible`, `faint` | shorten entry: `entryDuration = max(0.4, x*0.7)`     |
| `janky`, `abrupt`, `harsh`             | swap ease to `power2.inOut`                          |
| `slow`, `stuck`, `dragging`            | tighten stagger: `stagger *= 0.7`; `entryDuration *= 0.8` |
| `fast`, `rushed`, `blurry`             | loosen: `entryDuration *= 1.3`; `stagger *= 1.3`     |
| `cramped`, `tight`                     | `fontSize *= 1.1`                                    |
| `ending early`, `empty at end`         | extend `holdDuration` by 1s (visible-time pad)       |
| (no rule match)                        | fall back: bump `fontSize *= 0.95` if `readable<7`, else `entryDuration *= 1.15` |

Three iterations max per request. On the third pass, even if scores miss, we surface the best-scoring render (highest min-axis score, then highest sum).

## Flow

```
POST /api/motion/render
  body: { text, preset, logoUrl? }
  →
  jobId = uuid
  spawn async:
    params = preset.defaults
    for i in 1..3:
      mp4Path = render(preset, text, logoUrl, params, quality=draft)
      ffprobe sanity check
      verdict = judge(mp4Path)  // cached by MP4 hash
      log(i, params, verdict, spend)
      if all 4 ≥ 7: pass = mp4Path; break
      if spend > $0.90: surface partial; break
      params = iterate(params, verdict.issues)
    if pass:
      mp4Path = render(preset, text, logoUrl, params, quality=high)
    write status to renders/<jobId>.status.json
  return { jobId }

GET /api/motion/status?jobId=…
  reads renders/<jobId>.status.json
```

## Determinism / safety

- Hyperframes rules: no `Math.random()`, `Date.now()`, infinite repeats. Animations are 100% deterministic.
- All five compositions explicitly use a fixed seed where any randomness is needed (none currently do).
- `npx hyperframes lint` runs before every render. Lint failure ⇒ skip render + skip judge call, log the lint error, return failure.
- Judge cache by MP4 SHA-256 prevents double-charges on re-renders of identical bytes.

## Files

- `overnight/motion_design.md` — this file.
- `overnight/motion_render.log` — verbose per-render log.
- `motion/compositions/<preset>/index.html` — 5 presets.
- `apps/web/src/lib/motion/renderer.ts` — Hyperframes wrapper.
- `apps/web/src/lib/motion/judge.ts` — Gemini judge + cache.
- `apps/web/src/lib/motion/iterate.ts` — issues→params rules.
- `apps/web/src/lib/motion/types.ts` — shared types.
- `apps/web/src/lib/motion/presets.ts` — preset registry + defaults.
- `apps/web/src/lib/motion/pipeline.ts` — orchestrator (render→judge→iterate loop).
- `apps/web/src/app/motion/page.tsx` — form UI.
- `apps/web/src/app/api/motion/render/route.ts` — POST entry.
- `apps/web/src/app/api/motion/status/route.ts` — polling.
- `apps/web/tests/motion.e2e.ts` — typewriter-dark + logo-reveal end-to-end checks.
- `apps/web/tests/fixtures/sample-logo.svg` — test logo.

## Environment

`apps/web/.env`:

```
GEMINI_API_KEY=…  # mapped from .env's Google_AI_Studio
```
