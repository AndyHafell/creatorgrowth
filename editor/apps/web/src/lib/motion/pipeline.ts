import fs from "node:fs";
import path from "node:path";
import { RENDERS_DIR, ensureDirs } from "./paths";
import { render } from "./renderer";
import { judge } from "./judge";
import { iterate } from "./iterate";
import { PRESETS, mergeWithDefaults } from "./presets";
import { logBlock, logLine } from "./log";
import type {
  PipelineIteration,
  PipelineStatus,
  PresetId,
  RenderParams,
} from "./types";

const MAX_ITERATIONS = 3;
const BUDGET_CAP_USD = 1.0;
const BUDGET_ABORT_USD = 0.9;

function statusFilePath(jobId: string): string {
  return path.join(RENDERS_DIR, `${jobId}.status.json`);
}

export function writeStatus(s: PipelineStatus): void {
  ensureDirs();
  fs.writeFileSync(statusFilePath(s.jobId), JSON.stringify(s, null, 2), "utf8");
}

export function readStatus(jobId: string): PipelineStatus | null {
  const p = statusFilePath(jobId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

export interface RunOpts {
  jobId: string;
  preset: PresetId;
  userParams: Partial<RenderParams>;
  apiKey: string;
}

/**
 * Full render→judge→iterate loop with a 3-iteration cap and $0.90 abort.
 * Updates renders/<jobId>.status.json after every step.
 */
export async function runPipeline(opts: RunOpts): Promise<PipelineStatus> {
  const { jobId, preset, userParams, apiKey } = opts;
  const presetDef = PRESETS[preset];
  if (!presetDef) throw new Error(`unknown preset: ${preset}`);

  let params = mergeWithDefaults(preset, userParams);
  let cumulativeSpend = 0;
  const iterations: PipelineIteration[] = [];
  const status: PipelineStatus = {
    jobId,
    preset,
    state: "running",
    iterations,
    cumulativeSpendUsd: 0,
    startedAt: new Date().toISOString(),
  };
  writeStatus(status);

  let bestRender: { mp4Path: string; min: number; sum: number } | null = null;
  let bestJudge = status.bestJudge;

  for (let i = 1; i <= MAX_ITERATIONS; i++) {
    const iter: PipelineIteration = {
      iteration: i,
      paramsBefore: { ...params },
      decision: "iterate",
      notes: [],
    };
    iterations.push(iter);
    writeStatus(status);

    logBlock("pipeline_iter_start", {
      jobId,
      preset,
      iteration: i,
      params,
    });

    const r = await render({
      preset,
      params,
      quality: "draft",
      jobId,
      iteration: i,
    });
    iter.render = r;

    if (!r.ok) {
      iter.decision = r.reason === "lint_failed" ? "lint_failed" : "give_up";
      iter.notes.push(`render failed: ${r.reason}: ${r.detail.slice(0, 200)}`);
      writeStatus(status);
      break;
    }

    let judgeResult;
    try {
      judgeResult = await judge(r.mp4Path, {
        apiKey,
        budgetCapUsd: BUDGET_ABORT_USD,
        cumulativeSpendUsd: cumulativeSpend,
        jobId,
      });
    } catch (err) {
      iter.decision = "budget_exhausted";
      iter.notes.push(`judge error: ${String(err)}`);
      writeStatus(status);
      break;
    }

    iter.judge = judgeResult;
    if (!judgeResult.cached) {
      cumulativeSpend = judgeResult.cumulativeSpendUsd;
    }
    status.cumulativeSpendUsd = cumulativeSpend;

    if (
      !bestRender ||
      judgeResult.minScore > bestRender.min ||
      (judgeResult.minScore === bestRender.min &&
        judgeResult.sumScore > bestRender.sum)
    ) {
      bestRender = {
        mp4Path: r.mp4Path,
        min: judgeResult.minScore,
        sum: judgeResult.sumScore,
      };
      bestJudge = judgeResult;
      status.bestJudge = judgeResult;
    }

    if (judgeResult.passes) {
      iter.decision = "pass";
      iter.notes.push(
        `pass at iter ${i} — min=${judgeResult.minScore}, sum=${judgeResult.sumScore}`,
      );
      writeStatus(status);
      break;
    }

    if (cumulativeSpend >= BUDGET_ABORT_USD) {
      iter.decision = "budget_exhausted";
      iter.notes.push(
        `budget abort at $${cumulativeSpend.toFixed(4)} (cap $${BUDGET_ABORT_USD})`,
      );
      writeStatus(status);
      break;
    }

    if (i === MAX_ITERATIONS) {
      iter.decision = "give_up";
      iter.notes.push("max iterations reached");
      writeStatus(status);
      break;
    }

    const { next, notes } = iterate(params, preset, judgeResult);
    iter.paramsAfter = next;
    iter.notes.push(...notes);
    params = next;
    writeStatus(status);
  }

  // Final pass at high quality if any iteration produced a passing render.
  const passing = iterations.find((it) => it.decision === "pass");
  if (passing && passing.render && passing.render.ok) {
    logLine(
      `pipeline: passing render found at iter ${passing.iteration}; rendering final high-quality`,
    );
    const finalParams =
      passing.paramsAfter ?? passing.paramsBefore;
    const finalR = await render({
      preset,
      params: finalParams,
      quality: "high",
      jobId,
      iteration: MAX_ITERATIONS + 1,
    });
    if (finalR.ok) {
      status.finalMp4Path = finalR.mp4Path;
    } else {
      // Fall back to the passing draft render.
      status.finalMp4Path = passing.render.mp4Path;
    }
  } else if (bestRender) {
    // No passing render — surface best-effort draft.
    status.finalMp4Path = bestRender.mp4Path;
  }

  status.bestJudge = bestJudge;
  status.cumulativeSpendUsd = cumulativeSpend;
  status.completedAt = new Date().toISOString();
  status.state = status.finalMp4Path ? "done" : "failed";
  writeStatus(status);

  if (status.finalMp4Path) {
    status.finalMp4Url = `/api/motion/file?jobId=${encodeURIComponent(
      jobId,
    )}&name=${encodeURIComponent(path.basename(status.finalMp4Path))}`;
    writeStatus(status);
  }

  return status;
}
