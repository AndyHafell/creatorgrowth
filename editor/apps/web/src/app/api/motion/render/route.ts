import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { runPipeline, writeStatus } from "@/lib/motion/pipeline";
import { PRESETS } from "@/lib/motion/presets";
import type { PresetId, RenderParams } from "@/lib/motion/types";
import { logLine } from "@/lib/motion/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_PRESETS: PresetId[] = [
  "typewriter-dark",
  "slide-bold",
  "glow-neon",
  "logo-reveal",
  "multi-logo-grid",
];

function readApiKey(): string | null {
  // Accept either GEMINI_API_KEY (canonical) or Google_AI_Studio (Andy's .env key name).
  return (
    process.env.GEMINI_API_KEY ||
    process.env.GOOGLE_AI_STUDIO ||
    process.env.Google_AI_Studio ||
    null
  );
}

export async function POST(req: Request) {
  const apiKey = readApiKey();
  if (!apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY not set" },
      { status: 500 },
    );
  }

  let body: {
    preset?: string;
    text?: string;
    logoSvg?: string;
    params?: Partial<RenderParams>;
    sync?: boolean;
  } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const preset = body.preset as PresetId | undefined;
  if (!preset || !ALLOWED_PRESETS.includes(preset)) {
    return NextResponse.json(
      { error: `preset must be one of: ${ALLOWED_PRESETS.join(", ")}` },
      { status: 400 },
    );
  }

  const text = (body.text ?? "").toString().slice(0, 240).trim();
  if (!text) {
    return NextResponse.json({ error: "text is required" }, { status: 400 });
  }

  const userParams: Partial<RenderParams> = {
    text,
    ...(body.params ?? {}),
  };
  if (typeof body.logoSvg === "string" && body.logoSvg.length > 0) {
    userParams.logoSvg = body.logoSvg.slice(0, 30_000);
  }

  if (PRESETS[preset].needsLogo && !userParams.logoSvg && preset === "logo-reveal") {
    // logo-reveal has a built-in fallback — let it through.
  }

  const jobId = randomUUID();

  // Seed the status file so polling works immediately.
  writeStatus({
    jobId,
    preset,
    state: "pending",
    iterations: [],
    cumulativeSpendUsd: 0,
    startedAt: new Date().toISOString(),
  });

  // Allow sync execution for tests; async (fire-and-forget) for the UI.
  if (body.sync) {
    try {
      const result = await runPipeline({
        jobId,
        preset,
        userParams,
        apiKey,
      });
      return NextResponse.json({ jobId, status: result });
    } catch (err) {
      logLine(`render route sync error: ${String(err)}`);
      return NextResponse.json(
        { jobId, error: String(err) },
        { status: 500 },
      );
    }
  }

  // Fire and forget (return immediately).
  void (async () => {
    try {
      await runPipeline({ jobId, preset, userParams, apiKey });
    } catch (err) {
      logLine(`render route async error: ${String(err)}`);
      const status = {
        jobId,
        preset,
        state: "failed" as const,
        iterations: [],
        cumulativeSpendUsd: 0,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        error: String(err),
      };
      writeStatus(status);
    }
  })();

  return NextResponse.json({ jobId });
}
