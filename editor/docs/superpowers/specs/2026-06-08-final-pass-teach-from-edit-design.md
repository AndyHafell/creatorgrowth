# Final Pass Part B v2 — "Teach from this edit" (the cut-learning loop)

**Date:** 2026-06-08
**Repo:** `~/dev/creatorgrowth-editor` (Next.js editor on the VPS) + `~/dev/creatorgrowth` (Flask, slice 2 only)
**Branch:** `motion-graphics-judged` (SHARED worktree)
**Builds on (shipped, do not rebuild):** Part B v1 rulebook inject (`readRulebook`/`writeRulebook`,
`buildPrompt` LEARNED EDITOR PREFERENCES, `analyze()` sends `rulebook`), Part A purple feedback
markers (`readFeedbackCache`/`FeedbackMarker`), analysis cache (`readAnalysisCache` → AI's `cuts`).

## Goal
After Andy hand-edits the AI's cuts and drops purple notes, **clicking "Send to Editor" distills
3–7 general cut rules** from (a) the before→after diff and (b) the purple notes, via Gemini (BYO key).
A quick popup lets him accept/edit/reject; accepted rules merge into the existing rulebook (de-duped)
and are injected into every future first pass. Separately, **Re-analyze must preserve his manual
keep/cut edits** (today it reseeds and only `locked` survives — which would destroy the diff signal).

Honest framing: one video won't transform the AI; value compounds over 5–10 videos as the rulebook
captures *systematic* errors.

## Trigger & UX (Andy's mental model)
edit → drop purple notes → **Send to Editor** → glance at proposed rules (accept/edit/reject) → it
sends. No separate button to remember. Popup is lightweight/inline (matches the no-side-panel call).
If the diff + notes are empty, skip silently (nothing to learn).

---

## Slice 1 — the loop + re-analyze-preserve (deploy 1, editor only)

### Pure functions (TDD first — `bun test`, mirror existing `__tests__`)
- **`final-pass/final-pass-diff.ts`** — `computeCutDiff({ aiCuts, segments, k, transcript })`
  → `{ overCuts: Span[], misses: Span[] }` where `Span = { startSec, endSec, text }` (media sec).
  - `aiCuts`: `{start,end}[]` media sec (from `Analysis.cuts`).
  - `segments`: `{startSec,endSec,status}[]` buffer sec (from `cutModel`).
  - `k = mediaDuration / bufferDuration`.
  - `transcript`: `{start,end,text}[]` media sec.
  - **over-cut** = an AI cut whose midpoint maps to a segment with status `keep` (AI cut / he kept).
  - **miss** = a segment with status `cut` whose media range overlaps NO AI cut (AI kept / he cut).
  - text = transcript segments overlapping the span, joined.
- **`final-pass/final-pass-rulebook-merge.ts`** — `mergeRules(existing: string, accepted: string[])`
  → rulebook text. Appends each accepted rule as `- {rule}`, de-duped case-insensitively against
  existing lines (strip leading `- `/`* `, trim, lowercase). Preserves order.
- **`lib/raw-cut/segments.ts`** — extract `carryManualEdits(prev, next, { preserveStatus })` from the
  inline rebuild-merge in `use-raw-cut-segments.ts`. For each `next` seg, find the `prev` seg
  containing its midpoint; always carry `locked`/`marked`; when `preserveStatus`, also carry
  `status` for segs flagged `userSet`. (New optional `userSet?: boolean` on `RawCutSegment`.)

### Backend route
- **`app/api/final-pass/learn/route.ts`** (NEW; covered by FILES entry `app/api/final-pass`) —
  stateless, BYO key (`x-gemini-key`, same as the cut route). Body: `{ overCuts, misses, notes }`.
  Meta-prompt: "You cut this video; the editor made these specific changes and left these notes —
  what did you SYSTEMATICALLY get wrong? Write 3–7 short, general rules in the editor's voice."
  `responseSchema` → `{ rules: [{ rule: string, rationale: string }] }`. Returns the rules.

### UI
- **`final-pass/final-pass-teach.tsx`** (NEW) — a controlled dialog component. Given the diff + notes,
  on open calls `/api/final-pass/learn`, renders each proposed rule with accept/edit/reject (rationale
  as subtext, all accepted by default), and on confirm `mergeRules` into the rulebook + persist.

### Re-analyze preserve
- `use-raw-cut-segments.ts`: add `preserveManualEdits?: boolean` param; use `carryManualEdits(..., {
  preserveStatus: preserveManualEdits })` in the rebuild effect. Manual mutations (`toggleStatusAt`,
  `sweepCutFrom`) set `userSet: true` on affected segs (in `segments.ts`).
- **Final Pass passes `preserveManualEdits: true`; Raw Cut omits it → byte-identical behavior.**

### Surface wiring (the ONLY agent-5-shared file — do last, deploy when he's off it)
- `final-pass-surface.tsx`: (1) add `preserveManualEdits: true` to the `useRawCutSegments({...})` call;
  (2) intercept "Send to Editor" → build diff (`computeCutDiff` from `analysis.cuts` + `cutModel`
  segments + `k` + transcript) + notes (`readFeedbackCache(assetId)`) → open `<FinalPassTeach/>` →
  on confirm proceed to send. Keep the diff tiny to minimize merge conflict with agent 5.

Slice-1 rulebook stays on v1 `readRulebook`/`writeRulebook` (localStorage) so the loop works end-to-end
immediately.

---

## Slice 2 — server-side per-account rulebook (deploy 2, editor + Flask)
- **Flask** (`~/dev/creatorgrowth/app.py`): `GET/POST /api/final-pass/rulebook`, session-scoped
  (reuse the Settings-v2 per-user store). Coordinate with the S3-migration agent; deploy via
  `rebuild.sh` separately (NOT push-finalpass.sh).
- **`final-pass-cache.ts`**: rulebook becomes server-backed with a **localStorage mirror** (keeps
  `readRulebook()` sync for the inject path) + async `fetchRulebookFromServer`/`saveRulebookToServer`
  + **one-time localStorage→server migration** so existing v1 rules aren't lost. Dialog + Teach save
  to server; surface fetches on mount.

---

## Constraints
- SHARED worktree: stage ONLY my files, NEVER `git add -A`.
- Deploy editor edits with `./push-finalpass.sh "msg"` (new lib/component files sit under already-listed
  dirs — no FILES change). Deploy Flask separately via `rebuild.sh`.
- Additive only to shared `use-raw-cut-segments.ts` / `segments.ts` / `raw-cut-waveform.tsx`; Raw Cut +
  Publishing must be unaffected (`preserveManualEdits` opt-in guarantees this).
- Agent 5 is live in `final-pass-surface.tsx` + `raw-cut-waveform.tsx` (purple markers) — I avoid both
  until his work lands; I never touch `raw-cut-waveform.tsx` at all for this feature.

## Verify before "done"
- `bunx tsc --noEmit -p apps/web/tsconfig.json`, `bunx biome check`, `bun test` green.
- TDD: diff + merge + carryManualEdits unit tests pass.
- Andy (manual, live): Send to Editor produces sensible rules from a real diff+notes; accept/edit/reject
  works; rules appear in "Cut rules" and persist; next Analyze honors them; Re-analyze no longer wipes
  manual keep/cut; Raw Cut + Publishing still work.
