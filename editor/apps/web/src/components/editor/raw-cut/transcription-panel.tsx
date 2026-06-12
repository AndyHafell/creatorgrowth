"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import type { AiCutSuggestion } from "@/lib/raw-cut/ai-cut";
import type { RawCutAiVerdict } from "@/lib/raw-cut/session-cache";
import { cn } from "@/utils/ui";

export type DetectStatus =
	| { kind: "idle" }
	| { kind: "preloading"; progress: number }
	| { kind: "decoding" }
	| { kind: "loading-model"; progress: number }
	| { kind: "transcribing"; progress: number }
	| { kind: "cloud" }
	| { kind: "analyzing" }
	| {
			kind: "done";
			durationMs: number;
			cached: boolean;
			autoApplied?: number;
			/** Finds below the confidence floor — dropped, never queued. */
			dropped?: number;
	  }
	| { kind: "error"; message: string };

interface TranscriptionPanelProps {
	status: DetectStatus;
	device: "webgpu" | "wasm" | null;
	onRun: () => void;
	onReanalyze: () => void;
	onCancel: () => void;
	suggestions: AiCutSuggestion[];
	verdict: RawCutAiVerdict | null;
	outline: string;
	onOutlineChange: (text: string) => void;
	onAccept: (id: string) => void;
	onReject: (id: string) => void;
	onAcceptAll: () => void;
	onImport: (file: File) => void;
	onClearAi: () => void;
	onSeek: (sec: number) => void;
	/** Live cut channel code (Claude Code pipeline) — null when not linked. */
	liveChannel: string | null;
	onLiveToggle: () => void;
}

export function TranscriptionPanel({
	status,
	device,
	onRun,
	onReanalyze,
	onCancel,
	suggestions,
	verdict,
	outline,
	onOutlineChange,
	onAccept,
	onReject,
	onAcceptAll,
	onImport,
	onClearAi,
	onSeek,
	liveChannel,
	onLiveToggle,
}: TranscriptionPanelProps) {
	const importRef = useRef<HTMLInputElement | null>(null);
	const busy =
		status.kind === "preloading" ||
		status.kind === "decoding" ||
		status.kind === "loading-model" ||
		status.kind === "transcribing" ||
		status.kind === "cloud" ||
		status.kind === "analyzing";
	const [showOutline, setShowOutline] = useState(false);

	return (
		<div className="flex flex-col gap-2">
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
				<div className="text-foreground text-sm font-medium">AI Cut</div>
				<span className="text-muted-foreground text-xs">
					Transcribes the keeps, then Gemini hunts retakes, false starts,
					filler, tangents → every confident cut is applied directly (red or
					nothing); weak finds are dropped. Toggle any clip back with Q/W/E.
				</span>
			</div>

			<div className="flex flex-wrap items-center gap-2">
				{!busy ? (
					<Button onClick={onRun} size="sm" className="h-8">
						Run AI Cut
					</Button>
				) : (
					<Button
						onClick={onCancel}
						size="sm"
						variant="outline"
						className="h-8"
					>
						Cancel
					</Button>
				)}

				{!busy && status.kind === "done" && (
					<Button
						onClick={onReanalyze}
						size="sm"
						variant="ghost"
						className="h-8 text-xs"
						title="Force a fresh Gemini analysis (re-bills your key)"
					>
						Re-analyze
					</Button>
				)}

				<Button
					onClick={() => setShowOutline((v) => !v)}
					size="sm"
					variant="ghost"
					className="h-8 text-xs"
					title="Give the AI your video plan so it can tell tangents from the point"
				>
					{showOutline ? "Hide outline" : "Outline"}
					{!showOutline && outline.trim() && " ·"}
				</Button>

				<Button
					onClick={() => importRef.current?.click()}
					size="sm"
					variant="ghost"
					className="h-8 text-xs"
					title="Load a cut-list JSON from an external editor (e.g. a Claude agent): {cuts: [{start, end, kind, reason, confidence}]} in media seconds"
				>
					Import cuts
				</Button>
				<Button
					onClick={onLiveToggle}
					size="sm"
					variant={liveChannel ? "outline" : "ghost"}
					className={cn(
						"h-8 text-xs",
						liveChannel &&
							"border-green-500/50 bg-green-500/10 text-green-500 hover:bg-green-500/20",
					)}
					title={
						liveChannel
							? "Live link open — an external Claude Code agent can push and adjust cuts in this session. Click to close."
							: "Open a live channel so a Claude Code agent can push cuts directly into this session"
					}
				>
					{liveChannel ? `● live ${liveChannel}` : "Live link"}
				</Button>
				{(verdict || suggestions.length > 0) && (
					<Button
						onClick={onClearAi}
						size="sm"
						variant="ghost"
						className="text-muted-foreground h-8 text-xs"
						title="Remove ALL AI cuts (auto-applied + suggestions) — back to silence-only"
					>
						Clear AI
					</Button>
				)}
				<input
					ref={importRef}
					type="file"
					accept=".json,application/json"
					className="hidden"
					onChange={(e) => {
						const f = e.target.files?.[0];
						if (f) onImport(f);
						e.target.value = "";
					}}
				/>

				<StatusBadge status={status} />

				{device && status.kind !== "preloading" && (
					<DeviceBadge device={device} />
				)}
			</div>

			{showOutline && (
				<textarea
					value={outline}
					onChange={(e) => onOutlineChange(e.target.value)}
					placeholder="Paste the video's outline / prep doc steps (optional). The AI uses it to tell a tangent from the actual point."
					className="bg-muted/30 text-foreground placeholder:text-muted-foreground/60 h-24 w-full resize-y rounded border p-2 font-mono text-xs outline-none"
				/>
			)}

			{verdict && (
				<div className="text-muted-foreground text-xs">
					<span
						className={cn(
							"mr-2 rounded px-1.5 py-0.5 font-semibold tabular-nums",
							verdict.score >= 7
								? "bg-green-500/20 text-green-500"
								: "bg-yellow-500/20 text-yellow-500",
						)}
					>
						{verdict.score.toFixed(1)}/10
					</span>
					{verdict.reason}
				</div>
			)}

			{suggestions.length > 0 && (
				<SuggestionList
					suggestions={suggestions}
					onAccept={onAccept}
					onReject={onReject}
					onAcceptAll={onAcceptAll}
					onSeek={onSeek}
				/>
			)}
		</div>
	);
}

function DeviceBadge({ device }: { device: "webgpu" | "wasm" }) {
	const isGpu = device === "webgpu";
	return (
		<span
			className={
				isGpu
					? "rounded border border-green-500/40 bg-green-500/10 px-1.5 py-0.5 text-[10px] font-medium text-green-500"
					: "text-muted-foreground rounded border px-1.5 py-0.5 text-[10px] font-medium"
			}
			title={
				isGpu
					? "Running on the GPU"
					: "Running on the CPU (WebGPU not available)"
			}
		>
			{isGpu ? "WebGPU" : "CPU"}
		</span>
	);
}

function StatusBadge({ status }: { status: DetectStatus }) {
	const elapsedSec = useElapsedSec(
		status.kind === "transcribing" ||
			status.kind === "loading-model" ||
			status.kind === "decoding" ||
			status.kind === "cloud" ||
			status.kind === "analyzing" ||
			status.kind === "preloading",
	);
	switch (status.kind) {
		case "idle":
			return null;
		case "preloading":
			return (
				<span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
					<Pulse />
					Preloading model… {clampPct(status.progress)}%
				</span>
			);
		case "decoding":
			return (
				<span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
					<Pulse />
					Preparing audio… ({formatElapsed(elapsedSec)})
				</span>
			);
		case "loading-model":
			return (
				<span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
					<Pulse />
					Loading model… {clampPct(status.progress)}%
				</span>
			);
		case "cloud":
			return (
				<span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
					<Pulse />
					Transcribing in the cloud… ({formatElapsed(elapsedSec)} elapsed)
				</span>
			);
		case "transcribing": {
			const pct = clampPct(status.progress);
			return (
				<span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
					<Pulse />
					Transcribing…
					{pct > 0 && <span> {pct}%</span>}
					<span> ({formatElapsed(elapsedSec)} elapsed)</span>
				</span>
			);
		}
		case "analyzing":
			return (
				<span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
					<Pulse />
					Gemini is reading the transcript… ({formatElapsed(elapsedSec)})
				</span>
			);
		case "done":
			return (
				<span className="text-muted-foreground inline-flex items-center gap-1.5 text-xs">
					<span>Done in {(status.durationMs / 1000).toFixed(1)}s</span>
					{(status.autoApplied ?? 0) > 0 && (
						<span
							className="rounded border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-400"
							title="Cuts applied directly (red or nothing) — toggle any clip back with Q/W/E"
						>
							{status.autoApplied} cuts applied
						</span>
					)}
					{(status.dropped ?? 0) > 0 && (
						<span
							className="text-muted-foreground rounded border px-1.5 py-0.5 text-[10px] font-medium"
							title="Finds below the confidence floor — dropped, not applied"
						>
							{status.dropped} dropped
						</span>
					)}
					{status.cached && (
						<span
							className="rounded border border-blue-500/40 bg-blue-500/10 px-1.5 py-0.5 text-[10px] font-medium text-blue-500"
							title="Transcript loaded from local cache (no transcription run)"
						>
							cached
						</span>
					)}
				</span>
			);
		case "error":
			return (
				<span className="text-destructive text-xs">⚠ {status.message}</span>
			);
	}
}

function Pulse() {
	return (
		<span className="relative inline-flex h-2 w-2">
			<span className="bg-blue-500/60 absolute inline-flex h-full w-full animate-ping rounded-full" />
			<span className="bg-blue-500 relative inline-flex h-2 w-2 rounded-full" />
		</span>
	);
}

function useElapsedSec(active: boolean): number {
	const [now, setNow] = useState(0);
	const startRef = useRef<number | null>(null);
	useEffect(() => {
		if (!active) {
			startRef.current = null;
			setNow(0);
			return;
		}
		if (startRef.current == null) startRef.current = Date.now();
		setNow(Math.floor((Date.now() - startRef.current) / 1000));
		const id = setInterval(() => {
			if (startRef.current == null) return;
			setNow(Math.floor((Date.now() - startRef.current) / 1000));
		}, 1000);
		return () => clearInterval(id);
	}, [active]);
	return now;
}

function formatElapsed(sec: number) {
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

// Row chip styling per cut kind. Mechanical kinds read "trustworthy" (red-ish,
// they're cuts); taste kinds read advisory (amber).
const KIND_STYLES: Record<string, string> = {
	marker: "border-purple-500/40 bg-purple-500/10 text-purple-400",
	retake: "border-red-500/40 bg-red-500/10 text-red-400",
	"false-start": "border-red-500/40 bg-red-500/10 text-red-400",
	filler: "border-orange-500/40 bg-orange-500/10 text-orange-400",
	tangent: "border-amber-500/40 bg-amber-500/10 text-amber-400",
	fluff: "border-amber-500/40 bg-amber-500/10 text-amber-400",
};

function SuggestionList({
	suggestions,
	onAccept,
	onReject,
	onAcceptAll,
	onSeek,
}: {
	suggestions: AiCutSuggestion[];
	onAccept: (id: string) => void;
	onReject: (id: string) => void;
	onAcceptAll: () => void;
	onSeek: (sec: number) => void;
}) {
	const totalSec = suggestions.reduce(
		(sum, s) => sum + Math.max(0, s.endSec - s.startSec),
		0,
	);
	return (
		<div className="mt-1 max-h-56 overflow-y-auto rounded border">
			<div className="bg-muted/30 text-muted-foreground sticky top-0 flex items-center justify-between border-b px-3 py-1.5 text-xs">
				<span>
					{suggestions.length} suggested cut
					{suggestions.length === 1 ? "" : "s"} · {Math.round(totalSec)}s · Y/N
					on the one under the playhead
				</span>
				<Button
					size="sm"
					variant="outline"
					className="h-6 px-2 text-xs"
					onClick={onAcceptAll}
				>
					Accept all
				</Button>
			</div>
			<ul className="divide-y">
				{suggestions.map((s) => (
					<li key={s.id} className="flex items-start gap-3 px-3 py-2 text-xs">
						<button
							type="button"
							onClick={() => onSeek(Math.max(0, s.startSec - 1.2))}
							className="text-muted-foreground hover:text-foreground shrink-0 font-mono tabular-nums"
							title="Play from just before this cut"
						>
							{formatTime(s.startSec)}
						</button>
						<div className="min-w-0 flex-1">
							<div className="flex items-baseline gap-1.5">
								<span
									className={cn(
										"shrink-0 rounded border px-1 py-px text-[10px] font-medium",
										KIND_STYLES[s.kind] ?? KIND_STYLES.fluff,
									)}
								>
									{s.kind}
								</span>
								<span className="text-muted-foreground/70 shrink-0 tabular-nums">
									{Math.round(s.confidence * 100)}%
								</span>
								<span className="text-muted-foreground truncate">
									{s.reason}
								</span>
							</div>
							<div className="text-foreground/90 mt-0.5 truncate">
								"{s.text}"
							</div>
						</div>
						<div className="flex shrink-0 gap-1">
							<Button
								size="sm"
								variant="outline"
								className="h-6 px-2 text-xs"
								onClick={() => onAccept(s.id)}
							>
								Cut
							</Button>
							<Button
								size="sm"
								variant="ghost"
								className="h-6 px-2 text-xs"
								onClick={() => onReject(s.id)}
							>
								Keep
							</Button>
						</div>
					</li>
				))}
			</ul>
		</div>
	);
}

function formatTime(sec: number) {
	const total = Math.round(sec);
	const m = Math.floor(total / 60);
	const s = total % 60;
	return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * The transcription worker emits init/transcribe progress in 0-100 range
 * (already a percentage). Just clamp + round; never multiply by 100.
 */
function clampPct(p: number): number {
	if (!Number.isFinite(p)) return 0;
	return Math.max(0, Math.min(100, Math.round(p)));
}
