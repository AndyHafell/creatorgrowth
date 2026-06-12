import type { PresetId, RenderParams } from "./types";

export interface PresetDef {
  id: PresetId;
  label: string;
  description: string;
  needsLogo: boolean;
  defaults: RenderParams;
}

export const PRESETS: Record<PresetId, PresetDef> = {
  "typewriter-dark": {
    id: "typewriter-dark",
    label: "Typewriter (dark)",
    description: "Monospace text writes on, dark grid background",
    needsLogo: false,
    defaults: {
      text: "hello what is going on",
      fontSize: 140,
      typeDuration: 2.6,
      caretColor: "#39d98a",
    },
  },
  "slide-bold": {
    id: "slide-bold",
    label: "Slide bold",
    description: "Words slide in stacked, heavy italic sans",
    needsLogo: false,
    defaults: {
      text: "hello what is going on",
      fontSize: 180,
      stagger: 0.14,
      entryDuration: 0.7,
      accentColor: "#ff5b3a",
    },
  },
  "glow-neon": {
    id: "glow-neon",
    label: "Glow neon",
    description: "Text fades in with neon glow and subtle pulse",
    needsLogo: false,
    defaults: {
      text: "hello what is going on",
      fontSize: 150,
      entryDuration: 0.9,
      glowColor: "#7c5cff",
    },
  },
  "logo-reveal": {
    id: "logo-reveal",
    label: "Logo reveal",
    description: "SVG stroke draws on then fills in",
    needsLogo: true,
    defaults: {
      text: "hello what is going on",
      drawDuration: 1.8,
      strokeColor: "#0ea5e9",
      fillColor: "#0ea5e9",
      logoSvg: "",
    },
  },
  "multi-logo-grid": {
    id: "multi-logo-grid",
    label: "Multi-logo grid",
    description: "2–6 logos stagger into a grid with scale-bounce",
    needsLogo: true,
    defaults: {
      text: "hello what is going on",
      logos: "A,B,C,D,E,F",
      stagger: 0.12,
      entryDuration: 0.65,
      accentColor: "#22c55e",
    },
  },
};

export function getPresetIds(): PresetId[] {
  return Object.keys(PRESETS) as PresetId[];
}

export function mergeWithDefaults(
  preset: PresetId,
  partial: Partial<RenderParams>,
): RenderParams {
  const defaults = PRESETS[preset].defaults;
  const out: RenderParams = { ...defaults, ...partial };
  if (!out.text || typeof out.text !== "string") out.text = defaults.text;
  return out;
}
