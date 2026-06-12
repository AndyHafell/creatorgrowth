/**
 * Smoke-test the motion pipeline against logo-reveal + sample logo.
 * Run: cd apps/web && bun run scripts/motion-smoke-logo.ts
 */
import fs from "node:fs";
import path from "node:path";
import { runPipeline } from "@/lib/motion/pipeline";

async function main() {
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
  const logoPath = path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "sample-logo.svg",
  );
  const logoSvg = fs.readFileSync(logoPath, "utf8");

  const jobId = `smoke-logo-${Date.now().toString(36)}`;
  console.log(`smoke: starting jobId=${jobId}`);
  const status = await runPipeline({
    jobId,
    preset: "logo-reveal",
    userParams: { text: "hello what's going on", logoSvg },
    apiKey,
  });
  if (!status.bestJudge) {
    console.error("no bestJudge — pipeline failed");
    process.exit(2);
  }
  const s = status.bestJudge.scores;
  console.log(JSON.stringify(status, null, 2));
  console.log(
    `final scores: readable=${s.readable} professional=${s.professional} timing=${s.timing} smoothness=${s.smoothness}`,
  );
}

void main();
