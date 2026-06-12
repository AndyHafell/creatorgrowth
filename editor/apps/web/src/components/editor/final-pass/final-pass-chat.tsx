"use client";

import { Clock, Send, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils/ui";

export interface FinalPassChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	// Tool calls the assistant made this turn (shown as subtle "✂️ …" notes).
	toolCalls?: Array<{ name: string; args: Record<string, unknown> }>;
}

const TOOL_LABEL: Record<string, string> = {
	set_score: "Updated score",
	set_projected_score: "Set projected score",
	add_cut: "Added a cut",
	remove_cut: "Removed a cut",
	keep_cut: "Kept a segment",
	update_cut: "Adjusted a cut",
};

function describeTool(name: string, args: Record<string, unknown>): string {
	const label = TOOL_LABEL[name] ?? name;
	if (name === "add_cut" || name === "update_cut") {
		const s = typeof args.start === "number" ? fmt(args.start) : null;
		const e = typeof args.end === "number" ? fmt(args.end) : null;
		return s && e ? `${label} (${s}–${e})` : label;
	}
	if (name === "set_score" || name === "set_projected_score") {
		return typeof args.score === "number"
			? `${label} → ${(args.score as number).toFixed(1)}`
			: label;
	}
	if (name === "remove_cut" || name === "keep_cut") {
		return typeof args.index === "number" ? `${label} #${args.index}` : label;
	}
	return label;
}

function fmt(sec: number): string {
	const m = Math.floor(sec / 60);
	const s = Math.floor(sec % 60);
	return `${m}:${String(s).padStart(2, "0")}`;
}

interface FinalPassChatProps {
	messages: FinalPassChatMessage[];
	loading: boolean;
	error: string | null;
	score: number;
	projectedScore: number | null;
	greenlit: boolean;
	cutCount: number;
	// Current video playhead, so Andy can drop "@ 0:17" into a prompt.
	currentTime: number;
	onSend: (text: string) => void;
	onClose: () => void;
}

export function FinalPassChat({
	messages,
	loading,
	error,
	score,
	projectedScore,
	greenlit,
	cutCount,
	currentTime,
	onSend,
	onClose,
}: FinalPassChatProps) {
	const [draft, setDraft] = useState("");
	const scrollRef = useRef<HTMLDivElement | null>(null);
	const textareaRef = useRef<HTMLTextAreaElement | null>(null);

	// Insert the current playhead time (e.g. "0:17") at the cursor so Andy can
	// reference an exact moment in his prompt without reading it off the player.
	const insertTimestamp = () => {
		const ts = fmt(currentTime);
		const ta = textareaRef.current;
		if (!ta) {
			setDraft((d) => `${d}${d && !/\s$/.test(d) ? " " : ""}${ts} `);
			return;
		}
		const start = ta.selectionStart ?? draft.length;
		const end = ta.selectionEnd ?? draft.length;
		const before = draft.slice(0, start);
		const after = draft.slice(end);
		const lead = before.length > 0 && !/\s$/.test(before) ? " " : "";
		const trail = after.length > 0 && !/^\s/.test(after) ? " " : " ";
		const piece = `${lead}${ts}${trail}`;
		setDraft(before + piece + after);
		const caret = (before + piece).length;
		requestAnimationFrame(() => {
			ta.focus();
			ta.setSelectionRange(caret, caret);
		});
	};

	// Stick to the bottom as the conversation grows / the bot thinks.
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-scroll on each new message + loading toggle
	useEffect(() => {
		const el = scrollRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [messages, loading]);

	const send = () => {
		const text = draft.trim();
		if (!text || loading) return;
		onSend(text);
		setDraft("");
	};

	return (
		<div className="bg-background flex h-full w-[24rem] shrink-0 flex-col border-l">
			{/* Header — title + the score it owns. */}
			<div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
				<div className="flex items-center gap-2 text-sm font-medium">
					<Sparkles className="h-4 w-4 text-yellow-500" />
					AI Final Pass
				</div>
				<div className="flex items-center gap-2">
					<span
						className={cn(
							"rounded px-1.5 py-0.5 text-xs font-semibold tabular-nums",
							greenlit
								? "bg-green-500/20 text-green-500"
								: "bg-yellow-500/20 text-yellow-500",
						)}
						title={greenlit ? "Greenlit (≥ 7.0)" : "Not greenlit yet (< 7.0)"}
					>
						{score.toFixed(1)}
					</span>
					{projectedScore != null && projectedScore !== score && (
						<span
							className="text-muted-foreground rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums"
							title="Projected score if you make the cuts"
						>
							→ {projectedScore.toFixed(1)}
						</span>
					)}
					<button
						type="button"
						onClick={onClose}
						className="text-muted-foreground hover:text-foreground"
						aria-label="Close chat"
					>
						<X className="h-4 w-4" />
					</button>
				</div>
			</div>

			{/* Conversation. */}
			<div
				ref={scrollRef}
				className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3"
			>
				{messages.length === 0 && !loading && (
					<div className="text-muted-foreground m-auto max-w-xs text-center text-xs">
						The AI watched your video. It’s working out the score and the cuts…
					</div>
				)}
				{messages.map((m) => (
					<div
						key={m.id}
						className={cn(
							"flex flex-col gap-1",
							m.role === "user" ? "items-end" : "items-start",
						)}
					>
						<div
							className={cn(
								"max-w-[90%] whitespace-pre-wrap rounded-lg px-3 py-2 text-sm",
								m.role === "user"
									? "bg-primary text-primary-foreground"
									: "bg-muted text-foreground",
							)}
						>
							{m.content}
						</div>
						{m.toolCalls && m.toolCalls.length > 0 && (
							<div className="text-muted-foreground whitespace-pre-line pl-1 text-xs italic">
								{m.toolCalls
									.map((t) => `✂ ${describeTool(t.name, t.args)}`)
									.join("\n")}
							</div>
						)}
					</div>
				))}
				{loading && (
					<div className="text-muted-foreground flex items-center gap-2 text-sm">
						<span className="bg-muted inline-flex items-center gap-1 rounded-lg px-3 py-2">
							<span className="animate-pulse">Thinking…</span>
						</span>
					</div>
				)}
				{error && <div className="text-destructive text-xs">⚠ {error}</div>}
			</div>

			{/* Composer. */}
			<div className="shrink-0 border-t p-2">
				<div className="mb-1 flex items-center justify-between gap-2 px-1">
					<span className="text-muted-foreground text-xs">
						{cutCount} active {cutCount === 1 ? "cut" : "cuts"} · ask it to add,
						remove, or change them
					</span>
					<button
						type="button"
						onClick={insertTimestamp}
						title="Insert the current video time into your message"
						className="text-muted-foreground hover:text-foreground hover:bg-muted flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-xs tabular-nums"
					>
						<Clock className="h-3 w-3" /> {fmt(currentTime)}
					</button>
				</div>
				<div className="flex items-end gap-2">
					<textarea
						ref={textareaRef}
						value={draft}
						onChange={(e) => setDraft(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter" && !e.shiftKey) {
								e.preventDefault();
								send();
							}
						}}
						rows={2}
						placeholder="e.g. why cut the intro? · keep cut #2 · tighten the ending"
						className="bg-background focus:ring-ring max-h-40 min-h-0 flex-1 resize-none rounded-md border px-2 py-1.5 text-sm focus:outline-none focus:ring-1"
					/>
					<Button
						size="sm"
						className="h-9 w-9 shrink-0 p-0"
						onClick={send}
						disabled={loading || draft.trim().length === 0}
						aria-label="Send"
					>
						<Send className="h-4 w-4" />
					</Button>
				</div>
			</div>
		</div>
	);
}
