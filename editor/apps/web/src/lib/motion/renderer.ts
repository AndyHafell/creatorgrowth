import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import {
  COMPOSITIONS_DIR,
  RENDERS_DIR,
  ensureDirs,
} from "./paths";
import { logBlock, logLine } from "./log";
import type {
  PresetId,
  Quality,
  RenderOutcome,
  RenderParams,
} from "./types";

const execFileP = promisify(execFile);

function runCmd(
  cmd: string,
  args: string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let killed = false;
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          killed = true;
          child.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;
    child.stdout.on("data", (b) => {
      stdout += b.toString();
    });
    child.stderr.on("data", (b) => {
      stderr += b.toString();
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: killed ? 124 : code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

async function ffprobe(
  mp4: string,
): Promise<{ codec: string; width: number; height: number; fps: number; duration: number } | null> {
  try {
    const { stdout } = await execFileP("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=codec_name,width,height,r_frame_rate",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      mp4,
    ]);
    const j = JSON.parse(stdout);
    const s = j.streams?.[0] ?? {};
    const fpsRaw = String(s.r_frame_rate ?? "0/1");
    const [n, d] = fpsRaw.split("/").map(Number);
    const fps = d ? n / d : 0;
    return {
      codec: String(s.codec_name ?? ""),
      width: Number(s.width ?? 0),
      height: Number(s.height ?? 0),
      fps,
      duration: Number(j.format?.duration ?? 0),
    };
  } catch (err) {
    logLine(`ffprobe failed for ${mp4}: ${String(err)}`);
    return null;
  }
}

export async function render(opts: {
  preset: PresetId;
  params: RenderParams;
  quality: Quality;
  jobId: string;
  iteration: number;
}): Promise<RenderOutcome> {
  ensureDirs();
  const { preset, params, quality, jobId, iteration } = opts;
  const projectDir = path.join(COMPOSITIONS_DIR, preset);
  if (!fs.existsSync(projectDir)) {
    return {
      ok: false,
      reason: "render_failed",
      detail: `composition project not found: ${projectDir}`,
    };
  }

  // Build a JSON variables file for hyperframes --variables-file.
  // Only include the keys that the composition declares; safe to pass extras
  // (hyperframes warns on undeclared with --strict-variables only).
  const varsPath = path.join(
    RENDERS_DIR,
    `${jobId}_iter${iteration}_${preset}.vars.json`,
  );
  const filtered: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    filtered[k] = v;
  }
  fs.writeFileSync(varsPath, JSON.stringify(filtered, null, 2), "utf8");

  // Lint first; abort on lint errors.
  const lint = await runCmd(
    "npx",
    ["--no", "hyperframes", "lint", "--json"],
    { cwd: projectDir, timeoutMs: 60_000 },
  );
  // hyperframes lint exits non-zero on errors. Parse JSON to be robust.
  if (lint.code !== 0) {
    // Try to extract error count from JSON output
    let errors = "(parse failed)";
    try {
      // The lint output may include progress chars; find JSON braces.
      const m = lint.stdout.match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        errors = JSON.stringify(parsed.errors ?? parsed);
      }
    } catch {
      // ignore
    }
    logBlock("lint_failed", { preset, jobId, iteration, errors });
    return {
      ok: false,
      reason: "lint_failed",
      detail: errors,
    };
  }

  const mp4Path = path.join(
    RENDERS_DIR,
    `${jobId}_iter${iteration}_${preset}_${quality}.mp4`,
  );

  const renderArgs = [
    "--no",
    "hyperframes",
    "render",
    "--variables-file",
    varsPath,
    "--output",
    mp4Path,
    "--quality",
    quality,
    "--workers",
    "1",
  ];

  const t0 = Date.now();
  const r = await runCmd("npx", renderArgs, {
    cwd: projectDir,
    timeoutMs: 300_000,
  });
  const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);

  if (r.code !== 0 || !fs.existsSync(mp4Path)) {
    const tail = (r.stderr + "\n" + r.stdout).split("\n").slice(-30).join("\n");
    logBlock("render_failed", {
      preset,
      jobId,
      iteration,
      code: r.code,
      elapsedSec,
      tail,
    });
    return {
      ok: false,
      reason: "render_failed",
      detail: tail,
    };
  }

  const probe = await ffprobe(mp4Path);
  if (!probe) {
    return {
      ok: false,
      reason: "probe_failed",
      detail: "ffprobe returned no data",
    };
  }

  // Per-spec verification: h264, 9.5≤duration≤10.5, 1920x1080, 30fps
  const okShape =
    probe.codec === "h264" &&
    probe.duration >= 9.5 &&
    probe.duration <= 10.5 &&
    probe.width === 1920 &&
    probe.height === 1080 &&
    Math.abs(probe.fps - 30) < 1.0;

  if (!okShape) {
    logBlock("probe_check_failed", {
      preset,
      jobId,
      iteration,
      probe,
    });
    return {
      ok: false,
      reason: "probe_failed",
      detail: JSON.stringify(probe),
    };
  }

  logBlock("render_ok", {
    preset,
    jobId,
    iteration,
    quality,
    elapsedSec,
    mp4Path,
    probe,
  });

  return {
    ok: true,
    mp4Path,
    durationSec: probe.duration,
    width: probe.width,
    height: probe.height,
    codec: probe.codec,
    fps: probe.fps,
  };
}
