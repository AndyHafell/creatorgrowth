import fs from "node:fs";
import { OVERNIGHT_LOG, ensureDirs } from "./paths";

let initialized = false;

function init(): void {
  if (initialized) return;
  ensureDirs();
  initialized = true;
}

export function logLine(line: string): void {
  init();
  const stamp = new Date().toISOString();
  const out = `[${stamp}] ${line}\n`;
  fs.appendFileSync(OVERNIGHT_LOG, out, "utf8");
  // Mirror to stderr so `next dev` shows it too.
  process.stderr.write(out);
}

export function logBlock(title: string, body: Record<string, unknown>): void {
  init();
  const stamp = new Date().toISOString();
  const lines = [
    `[${stamp}] === ${title} ===`,
    ...Object.entries(body).map(
      ([k, v]) => `  ${k}: ${typeof v === "string" ? v : JSON.stringify(v)}`,
    ),
    "",
  ];
  const out = lines.join("\n");
  fs.appendFileSync(OVERNIGHT_LOG, out, "utf8");
  process.stderr.write(out);
}
