/**
 * End-to-end test for /motion.
 *
 * Drives the pipeline directly (not over HTTP) so it can run without
 * `next start`. The pipeline IS the same code path the API route uses.
 *
 * Pass condition (per goal spec):
 *   - typewriter-dark + "hello what's going on" → MP4 with all 4 dimensions ≥ 7
 *   - logo-reveal + tests/fixtures/sample-logo.svg → same bar
 *
 * Run: cd apps/web && bun test tests/motion.e2e.ts
 *      or: npx tsx tests/motion.e2e.ts
 */

import { describe, it, expect } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { runPipeline } from "@/lib/motion/pipeline";
import type { PipelineStatus } from "@/lib/motion/types";

const PASS_THRESHOLD = 7;
const TEST_TIMEOUT_MS = 30 * 60 * 1000; // 30 min — full 3-iter loop x render + judge

// Bun test doesn't auto-load .env.local in apps/web; load it manually.
function loadDotEnv(): void {
  const envPath = path.resolve(__dirname, "..", ".env.local");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*)\s*$/i);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

function loadApiKey(): string {
  loadDotEnv();
  const k =
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_AI_STUDIO ||
    process.env.Google_AI_Studio;
  if (!k) {
    throw new Error(
      "GEMINI_API_KEY missing. Set it in apps/web/.env.local or the shell.",
    );
  }
  return k;
}

function loadSampleLogo(): string {
  const p = path.join(__dirname, "fixtures", "sample-logo.svg");
  return fs.readFileSync(p, "utf8");
}

function jobIdFromTitle(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `e2e-${slug}-${Date.now().toString(36)}`;
}

function summarize(s: PipelineStatus): string {
  const lines: string[] = [];
  lines.push(`state: ${s.state}`);
  lines.push(`final: ${s.finalMp4Path ?? "(none)"}`);
  lines.push(`spend: $${s.cumulativeSpendUsd.toFixed(4)}`);
  if (s.bestJudge) {
    lines.push(
      `best scores: r=${s.bestJudge.scores.readable} p=${s.bestJudge.scores.professional} t=${s.bestJudge.scores.timing} s=${s.bestJudge.scores.smoothness} (min=${s.bestJudge.minScore})`,
    );
  }
  for (const it of s.iterations) {
    const j = it.judge;
    lines.push(
      `  iter ${it.iteration}: ${it.decision}` +
        (j
          ? ` r=${j.scores.readable} p=${j.scores.professional} t=${j.scores.timing} s=${j.scores.smoothness}`
          : ""),
    );
    for (const n of it.notes) lines.push(`    · ${n}`);
  }
  return lines.join("\n");
}

describe("motion pipeline e2e", () => {
  it(
    "typewriter-dark with text=\"hello what's going on\" scores ≥7 on all 4 axes",
    async () => {
      const apiKey = loadApiKey();
      const jobId = jobIdFromTitle("typewriter");
      const status = await runPipeline({
        jobId,
        preset: "typewriter-dark",
        userParams: { text: "hello what's going on" },
        apiKey,
      });

      // eslint-disable-next-line no-console
      console.log("\n=== typewriter-dark ===\n" + summarize(status));

      expect(status.state).toBe("done");
      expect(status.finalMp4Path).toBeTruthy();
      expect(fs.existsSync(status.finalMp4Path!)).toBe(true);
      expect(status.bestJudge).toBeTruthy();
      const s = status.bestJudge!.scores;
      expect(s.readable).toBeGreaterThanOrEqual(PASS_THRESHOLD);
      expect(s.professional).toBeGreaterThanOrEqual(PASS_THRESHOLD);
      expect(s.timing).toBeGreaterThanOrEqual(PASS_THRESHOLD);
      expect(s.smoothness).toBeGreaterThanOrEqual(PASS_THRESHOLD);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "logo-reveal with sample-logo.svg scores ≥7 on all 4 axes",
    async () => {
      const apiKey = loadApiKey();
      const jobId = jobIdFromTitle("logo-reveal");
      const status = await runPipeline({
        jobId,
        preset: "logo-reveal",
        userParams: {
          text: "hello what's going on",
          logoSvg: loadSampleLogo(),
        },
        apiKey,
      });

      // eslint-disable-next-line no-console
      console.log("\n=== logo-reveal ===\n" + summarize(status));

      expect(status.state).toBe("done");
      expect(status.finalMp4Path).toBeTruthy();
      expect(fs.existsSync(status.finalMp4Path!)).toBe(true);
      expect(status.bestJudge).toBeTruthy();
      const s = status.bestJudge!.scores;
      expect(s.readable).toBeGreaterThanOrEqual(PASS_THRESHOLD);
      expect(s.professional).toBeGreaterThanOrEqual(PASS_THRESHOLD);
      expect(s.timing).toBeGreaterThanOrEqual(PASS_THRESHOLD);
      expect(s.smoothness).toBeGreaterThanOrEqual(PASS_THRESHOLD);
    },
    TEST_TIMEOUT_MS,
  );
});
