import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  FRAMES_DIR,
  JUDGE_CACHE_FILE,
  ensureDirs,
} from "./paths";
import { logBlock, logLine } from "./log";
import type { JudgeResult, JudgeScores } from "./types";

const execFileP = promisify(execFile);

// Gemini 2.5 Flash pricing (USD per 1M tokens, prompt/output).
// Adjust if pricing changes — kept here so the spend log stays accurate.
const PRICE_INPUT_PER_M = 0.3;
const PRICE_OUTPUT_PER_M = 2.5;

const RUBRIC = `You are evaluating a motion graphics video. Five frames from t=0, 2.5, 5, 7.5, 10s.
Score 0-10 on each dimension. Return ONLY valid JSON, no prose:
{
  "readable": <0-10, is text/logo clearly visible in every frame>,
  "professional": <0-10, does it look polished vs janky/amateur>,
  "timing": <0-10, does the animation progress feel right across frames - not too fast, not stuck, not ending early>,
  "smoothness": <0-10, do consecutive frames suggest smooth motion vs jumpy/broken>,
  "issues": [<short strings: specific fixable problems, e.g. "text cut off right edge at t=5", "logo barely visible at t=0">]
}`;

function sha256(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function readCache(): Record<string, JudgeResult> {
  if (!fs.existsSync(JUDGE_CACHE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(JUDGE_CACHE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function writeCache(cache: Record<string, JudgeResult>): void {
  fs.writeFileSync(JUDGE_CACHE_FILE, JSON.stringify(cache, null, 2), "utf8");
}

async function extractFrames(mp4: string, hash: string): Promise<string[]> {
  ensureDirs();
  const outDir = path.join(FRAMES_DIR, hash);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  // Five frames at 30fps: indices 0, 75, 150, 225, 299 (clamp last to a real frame)
  const select =
    "select='eq(n\\,0)+eq(n\\,75)+eq(n\\,150)+eq(n\\,225)+eq(n\\,299)'";
  await execFileP("ffmpeg", [
    "-v",
    "error",
    "-y",
    "-i",
    mp4,
    "-vf",
    select,
    "-vsync",
    "vfr",
    path.join(outDir, "%d.png"),
  ]);
  const files = ["1.png", "2.png", "3.png", "4.png", "5.png"]
    .map((f) => path.join(outDir, f))
    .filter((p) => fs.existsSync(p));
  return files;
}

function parseJudge(text: string): { scores: JudgeScores; issues: string[] } | null {
  // Defensive parse — strip code fences, find first {…}
  const cleaned = text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const obj = JSON.parse(m[0]);
    const num = (v: unknown): number => {
      const n = Number(v);
      if (!Number.isFinite(n)) return 0;
      return Math.max(0, Math.min(10, n));
    };
    return {
      scores: {
        readable: num(obj.readable),
        professional: num(obj.professional),
        timing: num(obj.timing),
        smoothness: num(obj.smoothness),
      },
      issues: Array.isArray(obj.issues)
        ? obj.issues.map((x: unknown) => String(x)).filter(Boolean)
        : [],
    };
  } catch {
    return null;
  }
}

export interface JudgeOptions {
  apiKey: string;
  budgetCapUsd: number; // hard ceiling; spend >= this aborts.
  cumulativeSpendUsd: number; // prior spend this session.
  passThreshold?: number; // default 7
  jobId?: string;
}

export async function judge(
  mp4Path: string,
  opts: JudgeOptions,
): Promise<JudgeResult> {
  ensureDirs();
  const passThreshold = opts.passThreshold ?? 7;
  const hash = sha256(mp4Path);
  const cache = readCache();
  if (cache[hash]) {
    const cached = cache[hash];
    logLine(
      `judge: cache hit ${hash.substring(0, 12)} (mp4=${path.basename(mp4Path)})`,
    );
    return { ...cached, cached: true };
  }

  if (opts.cumulativeSpendUsd >= opts.budgetCapUsd) {
    throw new Error(
      `judge: budget already exhausted ($${opts.cumulativeSpendUsd.toFixed(4)} >= $${opts.budgetCapUsd})`,
    );
  }

  const frames = await extractFrames(mp4Path, hash);
  if (frames.length !== 5) {
    throw new Error(`judge: expected 5 frames, got ${frames.length}`);
  }

  const parts: Array<
    { text: string } | { inlineData: { mimeType: string; data: string } }
  > = [{ text: RUBRIC }];
  for (const f of frames) {
    parts.push({
      inlineData: {
        mimeType: "image/png",
        data: fs.readFileSync(f).toString("base64"),
      },
    });
  }

  const body = {
    contents: [{ role: "user", parts }],
    generationConfig: {
      temperature: 0.1,
      topP: 0.8,
      responseMimeType: "application/json",
    },
  };

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" +
    encodeURIComponent(opts.apiKey);

  const t0 = Date.now();
  const resp = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const elapsedMs = Date.now() - t0;

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(
      `judge: Gemini HTTP ${resp.status}: ${errText.slice(0, 500)}`,
    );
  }

  const json = (await resp.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    usageMetadata?: {
      promptTokenCount?: number;
      candidatesTokenCount?: number;
      totalTokenCount?: number;
    };
  };

  const text = json.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
  const parsed = parseJudge(text);
  if (!parsed) {
    logBlock("judge_parse_failed", { mp4: path.basename(mp4Path), text });
    throw new Error("judge: failed to parse Gemini response as JSON");
  }

  const promptTokens = json.usageMetadata?.promptTokenCount ?? 0;
  const candidatesTokens = json.usageMetadata?.candidatesTokenCount ?? 0;
  const spendUsd =
    (promptTokens / 1_000_000) * PRICE_INPUT_PER_M +
    (candidatesTokens / 1_000_000) * PRICE_OUTPUT_PER_M;

  const sumScore =
    parsed.scores.readable +
    parsed.scores.professional +
    parsed.scores.timing +
    parsed.scores.smoothness;
  const minScore = Math.min(
    parsed.scores.readable,
    parsed.scores.professional,
    parsed.scores.timing,
    parsed.scores.smoothness,
  );
  const passes = minScore >= passThreshold;

  const result: JudgeResult = {
    scores: parsed.scores,
    issues: parsed.issues,
    minScore,
    sumScore,
    passes,
    cached: false,
    spendUsd,
    cumulativeSpendUsd: opts.cumulativeSpendUsd + spendUsd,
    promptTokens,
    candidatesTokens,
  };

  cache[hash] = result;
  writeCache(cache);

  logBlock("judge_ok", {
    mp4: path.basename(mp4Path),
    elapsedMs,
    promptTokens,
    candidatesTokens,
    spendUsd: spendUsd.toFixed(6),
    cumulativeSpendUsd: result.cumulativeSpendUsd.toFixed(6),
    scores: parsed.scores,
    minScore,
    passes,
    issues: parsed.issues,
  });

  return result;
}
