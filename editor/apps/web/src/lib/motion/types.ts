export type PresetId =
  | "typewriter-dark"
  | "slide-bold"
  | "glow-neon"
  | "logo-reveal"
  | "multi-logo-grid";

export type Quality = "draft" | "standard" | "high";

export interface RenderParams {
  text: string;
  fontSize?: number;
  typeDuration?: number;
  entryDuration?: number;
  stagger?: number;
  caretColor?: string;
  accentColor?: string;
  glowColor?: string;
  strokeColor?: string;
  fillColor?: string;
  drawDuration?: number;
  logos?: string;
  logoSvg?: string;
}

export interface RenderRequest {
  preset: PresetId;
  params: RenderParams;
  quality: Quality;
  jobId: string;
  iteration: number;
}

export interface RenderResult {
  ok: true;
  mp4Path: string;
  durationSec: number;
  width: number;
  height: number;
  codec: string;
  fps: number;
}

export interface RenderFailure {
  ok: false;
  reason: "lint_failed" | "render_failed" | "probe_failed";
  detail: string;
}

export type RenderOutcome = RenderResult | RenderFailure;

export interface JudgeScores {
  readable: number;
  professional: number;
  timing: number;
  smoothness: number;
}

export interface JudgeResult {
  scores: JudgeScores;
  issues: string[];
  minScore: number;
  sumScore: number;
  passes: boolean;
  cached: boolean;
  spendUsd: number;
  cumulativeSpendUsd: number;
  promptTokens?: number;
  candidatesTokens?: number;
}

export interface PipelineIteration {
  iteration: number;
  paramsBefore: RenderParams;
  paramsAfter?: RenderParams;
  render?: RenderOutcome;
  judge?: JudgeResult;
  decision: "pass" | "iterate" | "give_up" | "budget_exhausted" | "lint_failed";
  notes: string[];
}

export interface PipelineStatus {
  jobId: string;
  preset: PresetId;
  state: "pending" | "running" | "done" | "failed";
  iterations: PipelineIteration[];
  finalMp4Path?: string;
  finalMp4Url?: string;
  bestJudge?: JudgeResult;
  cumulativeSpendUsd: number;
  startedAt: string;
  completedAt?: string;
  error?: string;
}
