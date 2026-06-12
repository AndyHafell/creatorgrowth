import path from "node:path";

// Resolve repo root: apps/web/src/lib/motion/paths.ts → up 5 levels = repo root.
// In dev (next dev), __dirname points to apps/web/.next/server/.../lib/motion/ or similar;
// we use process.cwd() instead which Next sets to apps/web in dev, and to the repo root
// otherwise. Walk up until we find a `motion/compositions/` folder.
import fs from "node:fs";

function findRepoRoot(): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, "motion", "compositions")) &&
      fs.existsSync(path.join(dir, "apps", "web"))
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Fallback: assume apps/web cwd
  return path.resolve(process.cwd(), "..", "..");
}

const ROOT = findRepoRoot();

export const REPO_ROOT = ROOT;
export const COMPOSITIONS_DIR = path.join(ROOT, "motion", "compositions");
export const RENDERS_DIR = path.join(ROOT, "renders");
export const FRAMES_DIR = path.join(ROOT, "frames");
export const OVERNIGHT_LOG = path.join(ROOT, "overnight", "motion_render.log");
export const JUDGE_CACHE_FILE = path.join(ROOT, "renders", ".judge_cache.json");

export function ensureDirs(): void {
  for (const d of [RENDERS_DIR, FRAMES_DIR, path.dirname(OVERNIGHT_LOG)]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}
