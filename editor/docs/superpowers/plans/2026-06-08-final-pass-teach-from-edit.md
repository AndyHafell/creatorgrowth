# Final Pass "Teach from this edit" — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (inline) — Andy wants speed + is testing live. TDD the three pure functions first.

**Goal:** On "Send to Editor", distill 3–7 general cut rules from the before→after diff + purple notes (Gemini, BYO key), let Andy accept/edit/reject, merge into the rulebook; and make Re-analyze preserve manual keep/cut edits.

**Architecture:** Three pure functions (TDD) + one stateless Gemini route + one dialog component, wired into the existing v1 rulebook. Re-analyze preserve = opt-in flag so Raw Cut is byte-identical. Slice 1 = localStorage rulebook (works now); Slice 2 = server-side per-account.

**Tech Stack:** Next.js (app router) + TypeScript, `bun test`, Gemini `gemini-3.5-flash`, Flask (slice 2).

**Deploy order (agent 5 is live in `final-pass-surface.tsx` + `raw-cut-waveform.tsx` — purple markers):** build Tasks 1–5 (off his files) first; do Task 6 (surface wiring) + deploy only when his tree is clean. I never touch `raw-cut-waveform.tsx`.

---

### Task 1: `computeCutDiff` pure function (TDD)
**Files:** Create `apps/web/src/components/editor/final-pass/final-pass-diff.ts`; Test `.../final-pass/__tests__/final-pass-diff.test.ts` (both under FILES `final-pass/`).

- over-cut = an AI cut whose midpoint lands in a `keep` segment (AI cut / he kept).
- miss = a `cut` segment overlapping NO AI cut (AI kept / he cut).
- AI cuts + transcript in MEDIA sec; segments in BUFFER sec; `k = media/buffer`.

```ts
export interface DiffSpan { startSec: number; endSec: number; text: string }
export interface CutDiff { overCuts: DiffSpan[]; misses: DiffSpan[] }
type AiCut = { start: number; end: number };
type Seg = { startSec: number; endSec: number; status: "keep" | "cut" };
type Word = { start: number; end: number; text: string };

function textInRange(transcript: Word[], startSec: number, endSec: number): string {
  return transcript
    .filter((t) => t.end > startSec && t.start < endSec)
    .map((t) => t.text.trim())
    .filter(Boolean)
    .join(" ")
    .trim();
}
function statusAtBuffer(segments: Seg[], bufSec: number): "keep" | "cut" | null {
  for (const s of segments) if (bufSec >= s.startSec && bufSec < s.endSec) return s.status;
  return segments.length ? segments[segments.length - 1].status : null;
}
export function computeCutDiff({ aiCuts, segments, k, transcript }: {
  aiCuts: AiCut[]; segments: Seg[]; k: number; transcript: Word[];
}): CutDiff {
  const kk = k > 0 ? k : 1;
  const overCuts: DiffSpan[] = [];
  for (const c of aiCuts) {
    const midBuf = ((c.start + c.end) / 2) / kk;
    if (statusAtBuffer(segments, midBuf) === "keep") {
      overCuts.push({ startSec: c.start, endSec: c.end, text: textInRange(transcript, c.start, c.end) });
    }
  }
  const misses: DiffSpan[] = [];
  for (const s of segments) {
    if (s.status !== "cut") continue;
    const a = s.startSec * kk, b = s.endSec * kk;
    if (!aiCuts.some((c) => c.end > a && c.start < b)) {
      misses.push({ startSec: a, endSec: b, text: textInRange(transcript, a, b) });
    }
  }
  return { overCuts, misses };
}
```

Tests: over-cut detection; miss detection; no-diff (segments match AI → both empty); k=2 conversion. Run `bun test apps/web/src/components/editor/final-pass/__tests__/final-pass-diff.test.ts`. Commit `git add` the two files.

---

### Task 2: `mergeRules` pure function (TDD)
**Files:** Create `apps/web/src/components/editor/final-pass/final-pass-rulebook-merge.ts` + test (under `final-pass/`).

```ts
export function mergeRules(existing: string, accepted: string[]): string {
  const strip = (l: string) => l.replace(/^\s*[-*]\s+/, "").trim();
  const seen = new Set(existing.split("\n").map((l) => strip(l).toLowerCase()).filter(Boolean));
  const additions: string[] = [];
  for (const raw of accepted) {
    const clean = strip(raw);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    additions.push(`- ${clean}`);
  }
  if (additions.length === 0) return existing;
  const base = existing.trimEnd();
  return (base ? [base, ...additions] : additions).join("\n");
}
```

Tests: empty existing+1 rule; append to existing; dedupe (case-insensitive, bullet-insensitive both directions); all-duplicate → unchanged. Commit.

---

### Task 3: `carryManualEdits` + `userSet` flag (TDD; refactor the inline merge)
**Files:** Modify `apps/web/src/lib/raw-cut/segments.ts` (FILES-listed); Test `apps/web/src/lib/raw-cut/__tests__/carry-manual-edits.test.ts`.

- Add `userSet?: boolean` to `RawCutSegment`.
- `toggleStatusAt`: set `userSet: true` on the flipped segment.
- `sweepCutFrom`: set `userSet: true` on segments flipped keep→cut.
- New pure fn:

```ts
export function carryManualEdits(
  prev: RawCutSegment[],
  next: RawCutSegment[],
  opts?: { preserveStatus?: boolean },
): RawCutSegment[] {
  if (prev.length === 0) return next;
  const preserveStatus = opts?.preserveStatus ?? false;
  let changed = false;
  const merged = next.map((s) => {
    const mid = (s.startSec + s.endSec) / 2;
    const old = prev.find((p) => mid >= p.startSec && mid < p.endSec);
    if (!old) return s;
    const carryFlags = old.locked || old.marked;
    const carryStatus = preserveStatus && old.userSet === true;
    if (!carryFlags && !carryStatus) return s;
    changed = true;
    return {
      ...s,
      ...(carryFlags ? { locked: old.locked, marked: old.marked } : {}),
      ...(carryStatus ? { status: old.status, userSet: true } : {}),
    };
  });
  return changed ? merged : next;
}
```

Tests: carries lock/mark (preserveStatus off — Raw Cut parity); carries `status` for userSet seg ONLY when preserveStatus on; does NOT carry status when preserveStatus off; empty prev → next. Commit.

---

### Task 4: wire `carryManualEdits` + `preserveManualEdits` into the hook
**Files:** Modify `apps/web/src/components/editor/raw-cut/use-raw-cut-segments.ts` (FILES-listed).

- Add `preserveManualEdits?: boolean` to the hook params.
- Replace the inline `next.map(...)` rebuild-merge (lines ~86–104) with `carryManualEdits(prev, buildSegments(...), { preserveStatus: preserveManualEdits })`.
- Default omitted → Raw Cut unchanged. Verify `bunx tsc`. Commit.

---

### Task 5: `learn` route + `FinalPassTeach` dialog
**Files:** Create `apps/web/src/app/api/final-pass/learn/route.ts` (under FILES `api/final-pass/`); Create `apps/web/src/components/editor/final-pass/final-pass-teach.tsx` (under `final-pass/`).

Route mirrors `api/final-pass/route.ts` (BYO `x-gemini-key`, `gemini-3.5-flash`, `responseMimeType: application/json` + schema). Body `{ overCuts, misses, notes }`. Schema `{ rules: [{ rule: string, rationale: string }] }`. Meta-prompt: "You made the first cut pass; the creator hand-corrected these + left these notes — what did you SYSTEMATICALLY get wrong? Write 3–7 short GENERAL rules in the creator's voice." Returns `{ rules }`.

`FinalPassTeach({ open, onClose, diff, notes, geminiKey })`: on open POST `/api/final-pass/learn`; render each rule with accept checkbox + editable input + rationale subtext; "Add to my rules & continue" → `mergeRules(readRulebook(), acceptedTexts)` → `writeRulebook` → `onClose()`; "Skip" → `onClose()`. Empty diff+notes → "Nothing to learn from this edit" + close. Verify `bunx tsc` + `bunx biome check`. Commit.

---

### Task 6: surface wiring + deploy (ONLY when agent 5's tree is clean)
**Files:** Modify `apps/web/src/components/editor/final-pass/final-pass-surface.tsx`.

1. Add `preserveManualEdits: true` to the `useRawCutSegments({...})` call.
2. In the "Send to Editor" handler: build `diff = computeCutDiff({ aiCuts: analysis.cuts, segments: cutModel.segments, k, transcript })` + `notes = readFeedbackCache(assetId)?.map(m => m.note) ?? []`; if `geminiKey && (diff.overCuts.length || diff.misses.length || notes.length)` → open `<FinalPassTeach/>` and run the real send in its `onClose`; else send directly.

Deploy: `git status` must show no agent-5 dirty files; then `./push-finalpass.sh "final pass: Teach from this edit — learn cut rules from the diff + notes; Re-analyze preserves manual edits"`. New files are under already-listed dirs (no FILES edit). Verify served.

---

### Task 7 (Slice 2): server-side rulebook
**Files:** `~/dev/creatorgrowth/app.py` (`GET/POST /api/final-pass/rulebook`, session-scoped — coordinate w/ S3 agent, deploy `rebuild.sh`); `final-pass-cache.ts` (server-backed + localStorage mirror + one-time migration); dialog + Teach + surface mount fetch. Separate deploy.

---

## Self-review
- Spec coverage: diff (T1), distill route (T5), review/merge (T5), inject (v1, unchanged), re-analyze preserve (T3/T4/T6), server-side (T7). ✓
- Types consistent: `CutDiff`/`DiffSpan` used T1→T5/T6; `computeCutDiff`/`mergeRules`/`carryManualEdits` names stable; `userSet` added T3 used T3/T4. ✓
- No placeholders: real code for all pure fns. T5/T6 component+wiring described against verified existing patterns (route.ts, FinalPassRulebook, readFeedbackCache). ✓
