"use client";

import { useEffect, useRef, useState } from "react";

type PresetId =
  | "typewriter-dark"
  | "slide-bold"
  | "glow-neon"
  | "logo-reveal"
  | "multi-logo-grid";

interface PresetOption {
  id: PresetId;
  label: string;
  description: string;
  needsLogo: boolean;
}

const PRESET_OPTIONS: PresetOption[] = [
  {
    id: "typewriter-dark",
    label: "Typewriter (dark)",
    description: "Monospace writes on a dark grid.",
    needsLogo: false,
  },
  {
    id: "slide-bold",
    label: "Slide bold",
    description: "Stacked italic words slide up, one accent color.",
    needsLogo: false,
  },
  {
    id: "glow-neon",
    label: "Glow neon",
    description: "Text fades in with neon glow + subtle pulse.",
    needsLogo: false,
  },
  {
    id: "logo-reveal",
    label: "Logo reveal",
    description: "Upload an SVG; stroke draws on then fills.",
    needsLogo: true,
  },
  {
    id: "multi-logo-grid",
    label: "Multi-logo grid",
    description: "2–6 logo glyphs stagger into a grid (comma-separated).",
    needsLogo: false,
  },
];

interface StatusPayload {
  jobId: string;
  state: "pending" | "running" | "done" | "failed";
  finalMp4Url?: string;
  bestJudge?: {
    scores: {
      readable: number;
      professional: number;
      timing: number;
      smoothness: number;
    };
    minScore: number;
    issues: string[];
    passes: boolean;
  };
  iterations: Array<{
    iteration: number;
    decision: string;
    notes: string[];
    judge?: {
      scores: {
        readable: number;
        professional: number;
        timing: number;
        smoothness: number;
      };
      issues: string[];
    };
  }>;
  cumulativeSpendUsd: number;
  error?: string;
}

export default function MotionPage() {
  const [text, setText] = useState("hello what's going on");
  const [preset, setPreset] = useState<PresetId>("typewriter-dark");
  const [logoSvg, setLogoSvg] = useState("");
  const [logoName, setLogoName] = useState("");
  const [logoGlyphs, setLogoGlyphs] = useState("A,B,C,D,E,F");
  const [submitting, setSubmitting] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusPayload | null>(null);
  const pollRef = useRef<NodeJS.Timeout | null>(null);

  const currentPreset = PRESET_OPTIONS.find((p) => p.id === preset);
  const showSvgUpload = preset === "logo-reveal";
  const showLogoGlyphs = preset === "multi-logo-grid";

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0];
    if (!f) {
      setLogoSvg("");
      setLogoName("");
      return;
    }
    setLogoName(f.name);
    if (f.name.toLowerCase().endsWith(".svg")) {
      const txt = await f.text();
      setLogoSvg(txt);
    } else {
      // For PNG: we'd ideally embed as <image href="data:image/png;base64,…"/>
      // wrapped in <svg>. For now, hint the user to upload SVG.
      const buf = await f.arrayBuffer();
      const b64 = arrayBufferToBase64(buf);
      const svg = `<svg viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><image href="data:${f.type};base64,${b64}" x="0" y="0" width="200" height="200" /></svg>`;
      setLogoSvg(svg);
    }
  }

  function arrayBufferToBase64(buffer: ArrayBuffer): string {
    let binary = "";
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setStatus(null);
    setJobId(null);

    const params: Record<string, unknown> = {};
    if (preset === "multi-logo-grid") params.logos = logoGlyphs;
    if (preset === "logo-reveal" && logoSvg) params.logoSvg = logoSvg;

    try {
      const resp = await fetch("/api/motion/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ preset, text, params, logoSvg }),
      });
      const j = await resp.json();
      if (!resp.ok) throw new Error(j.error || "render failed");
      setJobId(j.jobId);
      startPolling(j.jobId);
    } catch (err) {
      setStatus({
        jobId: "",
        state: "failed",
        iterations: [],
        cumulativeSpendUsd: 0,
        error: String(err),
      });
      setSubmitting(false);
    }
  }

  function startPolling(jid: string) {
    if (pollRef.current) clearInterval(pollRef.current);
    const tick = async () => {
      try {
        const r = await fetch(`/api/motion/status?jobId=${jid}`);
        if (!r.ok) return;
        const s = (await r.json()) as StatusPayload;
        setStatus(s);
        if (s.state === "done" || s.state === "failed") {
          if (pollRef.current) clearInterval(pollRef.current);
          setSubmitting(false);
        }
      } catch {
        // ignore transient
      }
    };
    void tick();
    pollRef.current = setInterval(tick, 2500);
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 px-6 py-12">
      <div className="mx-auto max-w-3xl">
        <h1 className="text-3xl font-bold mb-2">Motion graphics</h1>
        <p className="text-zinc-400 mb-8 text-sm">
          Author a 10-second Hyperframes composition. Gemini 2.5 Flash judges the result;
          if any rubric axis falls below 7, params auto-tune and we re-render (up to 3
          iterations). Final pass renders at high quality.
        </p>

        <form
          onSubmit={handleSubmit}
          className="space-y-6 bg-zinc-900 border border-zinc-800 rounded-lg p-6"
        >
          <div>
            <label className="block text-sm font-medium mb-2">Text</label>
            <input
              type="text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              maxLength={240}
              required
              className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded text-zinc-100 focus:outline-none focus:border-zinc-500"
              placeholder="hello what's going on"
            />
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Style</label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {PRESET_OPTIONS.map((p) => (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => setPreset(p.id)}
                  className={`text-left px-3 py-3 rounded border transition ${
                    preset === p.id
                      ? "bg-zinc-100 text-zinc-900 border-zinc-100"
                      : "bg-zinc-900 text-zinc-200 border-zinc-700 hover:border-zinc-500"
                  }`}
                >
                  <div className="font-medium text-sm">{p.label}</div>
                  <div className="text-xs opacity-70 mt-1">{p.description}</div>
                </button>
              ))}
            </div>
          </div>

          {showSvgUpload && (
            <div>
              <label className="block text-sm font-medium mb-2">
                Logo (SVG or PNG)
              </label>
              <input
                type="file"
                accept=".svg,image/svg+xml,image/png"
                onChange={handleLogoChange}
                className="text-sm text-zinc-300 file:mr-3 file:px-3 file:py-1.5 file:bg-zinc-700 file:text-zinc-100 file:border-0 file:rounded"
              />
              {logoName && (
                <p className="text-xs text-zinc-500 mt-2">
                  loaded: {logoName} ({logoSvg.length} chars)
                </p>
              )}
              {!logoName && (
                <p className="text-xs text-zinc-500 mt-2">
                  Leave empty to use the built-in "AF" placeholder.
                </p>
              )}
            </div>
          )}

          {showLogoGlyphs && (
            <div>
              <label className="block text-sm font-medium mb-2">
                Logo glyphs (comma-separated, 2–6 entries)
              </label>
              <input
                type="text"
                value={logoGlyphs}
                onChange={(e) => setLogoGlyphs(e.target.value)}
                className="w-full px-3 py-2 bg-zinc-950 border border-zinc-700 rounded text-zinc-100 focus:outline-none focus:border-zinc-500"
                placeholder="A,B,C,D,E,F"
              />
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || !text}
            className="w-full px-4 py-3 bg-emerald-500 text-zinc-950 rounded font-medium hover:bg-emerald-400 disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            {submitting ? "Rendering & judging…" : "Render"}
          </button>
        </form>

        {jobId && (
          <div className="mt-6 bg-zinc-900 border border-zinc-800 rounded-lg p-6">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-semibold">
                Job <code className="text-xs text-zinc-400">{jobId}</code>
              </h2>
              <span
                className={`text-xs px-2 py-1 rounded ${
                  status?.state === "done"
                    ? "bg-emerald-500/20 text-emerald-300"
                    : status?.state === "failed"
                      ? "bg-red-500/20 text-red-300"
                      : "bg-amber-500/20 text-amber-300"
                }`}
              >
                {status?.state ?? "starting"}
              </span>
            </div>

            {status?.error && (
              <p className="text-sm text-red-300 mb-3">{status.error}</p>
            )}

            {status?.finalMp4Url && (
              <video
                src={status.finalMp4Url}
                controls
                autoPlay
                loop
                className="w-full rounded mb-4 bg-black"
              />
            )}

            {status?.bestJudge && (
              <div className="mb-4 text-sm">
                <div className="grid grid-cols-4 gap-2">
                  {(["readable", "professional", "timing", "smoothness"] as const).map(
                    (axis) => {
                      const v = status.bestJudge!.scores[axis];
                      return (
                        <div
                          key={axis}
                          className={`px-3 py-2 rounded border ${
                            v >= 7
                              ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                              : "border-amber-500/40 bg-amber-500/10 text-amber-200"
                          }`}
                        >
                          <div className="text-xs opacity-70 capitalize">{axis}</div>
                          <div className="text-lg font-bold">{v}</div>
                        </div>
                      );
                    },
                  )}
                </div>
                {status.bestJudge.issues.length > 0 && (
                  <ul className="mt-3 text-xs text-zinc-400 list-disc pl-5 space-y-0.5">
                    {status.bestJudge.issues.map((iss, i) => (
                      <li key={i}>{iss}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {status && status.iterations.length > 0 && (
              <details className="text-xs text-zinc-400">
                <summary className="cursor-pointer text-zinc-300 mb-2">
                  Iterations ({status.iterations.length}) · Gemini spend $
                  {status.cumulativeSpendUsd.toFixed(4)}
                </summary>
                <div className="space-y-2 mt-2">
                  {status.iterations.map((it) => (
                    <div
                      key={it.iteration}
                      className="border-l-2 border-zinc-700 pl-3"
                    >
                      <div className="font-mono text-[11px] text-zinc-500">
                        iter {it.iteration} · {it.decision}
                        {it.judge &&
                          ` · min=${Math.min(
                            it.judge.scores.readable,
                            it.judge.scores.professional,
                            it.judge.scores.timing,
                            it.judge.scores.smoothness,
                          )}`}
                      </div>
                      {it.notes.map((n, i) => (
                        <div key={i} className="opacity-70">
                          {n}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
