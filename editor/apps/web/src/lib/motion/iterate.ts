import type { JudgeResult, PresetId, RenderParams } from "./types";

interface Rule {
  match: RegExp;
  apply: (p: RenderParams, preset: PresetId) => string | null;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

const RULES: Rule[] = [
  {
    match: /\b(cut off|cut-off|overflow|spill|spilling|clipped|clipping|off[- ]?screen|edge)\b/i,
    apply: (p) => {
      if (typeof p.fontSize === "number") {
        const before = p.fontSize;
        p.fontSize = clamp(Math.round(before * 0.9), 60, 260);
        return `fontSize ${before}→${p.fontSize} (overflow)`;
      }
      return null;
    },
  },
  {
    match: /\b(barely|invisible|faint|low contrast|hard to see|unclear)\b/i,
    apply: (p) => {
      const notes: string[] = [];
      if (typeof p.entryDuration === "number") {
        const before = p.entryDuration;
        p.entryDuration = clamp(before * 0.7, 0.35, 2.0);
        notes.push(`entryDuration ${before}→${p.entryDuration.toFixed(2)}`);
      }
      if (typeof p.typeDuration === "number") {
        const before = p.typeDuration;
        p.typeDuration = clamp(before * 0.7, 0.4, 4.0);
        notes.push(`typeDuration ${before}→${p.typeDuration.toFixed(2)}`);
      }
      if (typeof p.drawDuration === "number") {
        const before = p.drawDuration;
        p.drawDuration = clamp(before * 0.75, 0.6, 4.0);
        notes.push(`drawDuration ${before}→${p.drawDuration.toFixed(2)}`);
      }
      return notes.length ? notes.join(", ") : null;
    },
  },
  {
    match: /\b(janky|jittery|abrupt|harsh|jumpy|broken)\b/i,
    apply: () => {
      // Tracked qualitatively — actual ease is hard-coded in compositions.
      // Future: surface an ease variable. For now, soften by stretching entries.
      return "ease softening flagged (composition uses fixed eases)";
    },
  },
  {
    match: /\b(slow|stuck|dragging|too slow|sluggish)\b/i,
    apply: (p) => {
      const notes: string[] = [];
      if (typeof p.entryDuration === "number") {
        const before = p.entryDuration;
        p.entryDuration = clamp(before * 0.8, 0.35, 2.0);
        notes.push(`entryDuration ${before}→${p.entryDuration.toFixed(2)}`);
      }
      if (typeof p.stagger === "number") {
        const before = p.stagger;
        p.stagger = clamp(before * 0.7, 0.04, 0.4);
        notes.push(`stagger ${before}→${p.stagger.toFixed(3)}`);
      }
      if (typeof p.typeDuration === "number") {
        const before = p.typeDuration;
        p.typeDuration = clamp(before * 0.75, 0.4, 4.0);
        notes.push(`typeDuration ${before}→${p.typeDuration.toFixed(2)}`);
      }
      return notes.length ? notes.join(", ") : null;
    },
  },
  {
    match: /\b(fast|rushed|blurry|hard to follow|quick(ly)?|static|completes too|finishes too|no (further )?(animation|progression|motion|change)|leaving the (majority|rest|remainder))\b/i,
    apply: (p) => {
      const notes: string[] = [];
      if (typeof p.entryDuration === "number") {
        const before = p.entryDuration;
        p.entryDuration = clamp(before * 1.5, 0.35, 4.0);
        notes.push(`entryDuration ${before}→${p.entryDuration.toFixed(2)}`);
      }
      if (typeof p.stagger === "number") {
        const before = p.stagger;
        p.stagger = clamp(before * 1.5, 0.04, 0.6);
        notes.push(`stagger ${before}→${p.stagger.toFixed(3)}`);
      }
      if (typeof p.typeDuration === "number") {
        const before = p.typeDuration;
        p.typeDuration = clamp(before * 1.4, 0.6, 8.5);
        notes.push(`typeDuration ${before}→${p.typeDuration.toFixed(2)}`);
      }
      if (typeof p.drawDuration === "number") {
        const before = p.drawDuration;
        p.drawDuration = clamp(before * 1.4, 0.6, 7.0);
        notes.push(`drawDuration ${before}→${p.drawDuration.toFixed(2)}`);
      }
      return notes.length ? notes.join(", ") : null;
    },
  },
  {
    match: /\b(cramped|tight|small|too small)\b/i,
    apply: (p) => {
      if (typeof p.fontSize === "number") {
        const before = p.fontSize;
        p.fontSize = clamp(Math.round(before * 1.1), 60, 260);
        return `fontSize ${before}→${p.fontSize} (cramped)`;
      }
      return null;
    },
  },
  {
    match: /\b(ending early|empty (at )?(end|frame))\b/i,
    apply: () =>
      "ending-early flagged (compositions hold full text from settle through t=10)",
  },
];

export function iterate(
  prev: RenderParams,
  preset: PresetId,
  verdict: JudgeResult,
): { next: RenderParams; notes: string[] } {
  const next: RenderParams = { ...prev };
  const notes: string[] = [];
  let anyApplied = false;

  for (const issue of verdict.issues) {
    let matched = false;
    for (const rule of RULES) {
      if (rule.match.test(issue)) {
        const note = rule.apply(next, preset);
        if (note) {
          notes.push(`"${issue}" → ${note}`);
          anyApplied = true;
        } else {
          notes.push(`"${issue}" → matched rule (no param to tune)`);
        }
        matched = true;
        break;
      }
    }
    if (!matched) {
      notes.push(`"${issue}" → no matching rule`);
    }
  }

  if (!anyApplied) {
    // Fallback nudge based on weakest axis.
    const s = verdict.scores;
    if (s.readable < 7 && typeof next.fontSize === "number") {
      const before = next.fontSize;
      next.fontSize = clamp(Math.round(before * 0.95), 60, 260);
      notes.push(`fallback (readable=${s.readable}): fontSize ${before}→${next.fontSize}`);
    } else if (s.timing < 7) {
      // Spread animation across more of the 10s window
      if (typeof next.typeDuration === "number") {
        const before = next.typeDuration;
        next.typeDuration = clamp(before * 1.3, 0.6, 8.5);
        notes.push(
          `fallback (timing=${s.timing}): typeDuration ${before}→${next.typeDuration.toFixed(2)}`,
        );
      } else if (typeof next.drawDuration === "number") {
        const before = next.drawDuration;
        next.drawDuration = clamp(before * 1.3, 0.6, 7.0);
        notes.push(
          `fallback (timing=${s.timing}): drawDuration ${before}→${next.drawDuration.toFixed(2)}`,
        );
      } else if (typeof next.entryDuration === "number") {
        const before = next.entryDuration;
        next.entryDuration = clamp(before * 1.3, 0.35, 4.0);
        notes.push(
          `fallback (timing=${s.timing}): entryDuration ${before}→${next.entryDuration.toFixed(2)}`,
        );
      } else {
        notes.push(
          `fallback (timing=${s.timing}): no tunable timing param — composition update needed`,
        );
      }
    } else if (s.smoothness < 7 && typeof next.stagger === "number") {
      const before = next.stagger;
      next.stagger = clamp(before * 1.2, 0.04, 0.6);
      notes.push(`fallback (smoothness=${s.smoothness}): stagger ${before}→${next.stagger.toFixed(3)}`);
    } else {
      notes.push("fallback: no tunable param matched — params unchanged");
    }
  }

  return { next, notes };
}
