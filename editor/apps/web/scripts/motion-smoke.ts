/**
 * Smoke-test the motion pipeline end-to-end against typewriter-dark.
 * Run: cd apps/web && bun run scripts/motion-smoke.ts
 */
import fs from "node:fs";
import path from "node:path";
import { runPipeline } from "@/lib/motion/pipeline";

async function main() {
  // Try to load apps/web/.env.local manually since bun run doesn't auto-load it.
  const envPath = path.join(process.cwd(), ".env.local");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z_0-9]*)\s*=\s*(.*)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
  const apiKey =
    process.env.GEMINI_API_KEY ||
    process.env.Google_AI_Studio ||
    process.env.GOOGLE_AI_STUDIO;
  if (!apiKey) {
    console.error("GEMINI_API_KEY missing");
    process.exit(1);
  }
  const jobId = `smoke-${Date.now().toString(36)}`;
  console.log(`smoke: starting jobId=${jobId}`);
  const status = await runPipeline({
    jobId,
    preset: "typewriter-dark",
    userParams: { text: "hello what is going on" },
    apiKey,
  });
  console.log(JSON.stringify(status, null, 2));
  if (!status.bestJudge) {
    console.error("no bestJudge — pipeline failed");
    process.exit(2);
  }
  const s = status.bestJudge.scores;
  console.log(
    `final scores: readable=${s.readable} professional=${s.professional} timing=${s.timing} smoothness=${s.smoothness}`,
  );
}

void main();
