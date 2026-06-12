"use client";

import { GraduationCap, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { readRulebook, saveRulebook } from "./final-pass-cache";
import type { CutDiff } from "./final-pass-diff";
import { mergeRules } from "./final-pass-rulebook-merge";

// Part B v2 — "Teach from this edit". Fired from Send-to-Editor: distills the
// before→after cut diff + purple notes into 3–7 proposed rules (Gemini, BYO key),
// lets Andy accept/edit/reject, then merges the accepted ones into the rulebook.
// `onClose` always runs (apply OR skip) so the surface can continue the send.

interface ProposedRule {
	id: string;
	text: string;
	rationale: string;
	accepted: boolean;
}

export function FinalPassTeach({
	open,
	onClose,
	diff,
	notes,
	geminiKey,
}: {
	open: boolean;
	onClose: () => void;
	diff: CutDiff;
	notes: string[];
	geminiKey: string | null;
}) {
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [rules, setRules] = useState<ProposedRule[]>([]);

	const hasInput =
		diff.overCuts.length > 0 || diff.misses.length > 0 || notes.length > 0;

	useEffect(() => {
		if (!open) return;
		setError(null);
		setRules([]);
		if (!hasInput) return;
		if (!geminiKey) {
			setError("Add your Gemini API key in Final Pass → API keys first.");
			return;
		}
		let cancelled = false;
		setLoading(true);
		// The editor is mounted under basePath /editor; fetch the route relative to
		// it (a leading-slash "/api/..." would hit the Flask app, not Next.js).
		const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
		fetch(`${base}/api/final-pass/learn`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"x-gemini-key": geminiKey,
			},
			body: JSON.stringify({
				overCuts: diff.overCuts,
				misses: diff.misses,
				notes,
			}),
		})
			.then(async (res) => {
				const data = (await res.json()) as {
					rules?: Array<{ rule: string; rationale: string }>;
					error?: string;
				};
				if (cancelled) return;
				if (!res.ok) {
					setError(data.error || `Request failed (${res.status}).`);
					return;
				}
				setRules(
					(data.rules ?? []).map((r, i) => ({
						id: `rule-${i}`,
						text: r.rule,
						rationale: r.rationale,
						accepted: true,
					})),
				);
			})
			.catch((e: unknown) => {
				if (!cancelled) setError((e as Error).message);
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [open, hasInput, geminiKey, diff, notes]);

	const setRule = useCallback((id: string, patch: Partial<ProposedRule>) => {
		setRules((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
	}, []);

	const apply = useCallback(() => {
		const accepted = rules
			.filter((r) => r.accepted && r.text.trim())
			.map((r) => r.text.trim());
		if (accepted.length > 0) {
			saveRulebook(mergeRules(readRulebook(), accepted));
		}
		onClose();
	}, [rules, onClose]);

	const acceptedCount = rules.filter((r) => r.accepted && r.text.trim()).length;

	return (
		<Dialog
			open={open}
			onOpenChange={(o) => {
				if (!o) onClose();
			}}
		>
			<DialogContent className="max-w-lg">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<GraduationCap className="size-4" />
						Teach from this edit
					</DialogTitle>
					<DialogDescription>
						Rules learned from your cuts + notes. Accept, edit, or reject — the
						accepted ones join your “Cut rules” so the next video starts
						smarter.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="max-h-[55vh] overflow-y-auto">
					{!hasInput && (
						<p className="text-sm text-muted-foreground">
							Nothing to learn from this edit — no cut changes or notes vs. the
							AI's pass.
						</p>
					)}
					{hasInput && loading && (
						<div className="flex items-center gap-2 text-sm text-muted-foreground">
							<Loader2 className="size-4 animate-spin" />
							Reading your edits…
						</div>
					)}
					{error && <p className="text-sm text-red-500">{error}</p>}
					{!loading && !error && rules.length > 0 && (
						<ul className="flex flex-col gap-3">
							{rules.map((r) => (
								<li key={r.id} className="flex gap-2.5">
									<Checkbox
										checked={r.accepted}
										onCheckedChange={(c) =>
											setRule(r.id, { accepted: c === true })
										}
										className="mt-2"
									/>
									<div className="flex flex-1 flex-col gap-1">
										<Input
											value={r.text}
											onChange={(e) => setRule(r.id, { text: e.target.value })}
											className={r.accepted ? "" : "line-through opacity-50"}
										/>
										{r.rationale && (
											<span className="text-xs text-muted-foreground">
												{r.rationale}
											</span>
										)}
									</div>
								</li>
							))}
						</ul>
					)}
				</DialogBody>
				<DialogFooter>
					<Button variant="ghost" onClick={onClose}>
						Skip
					</Button>
					<Button onClick={apply} disabled={loading}>
						{acceptedCount > 0
							? `Add ${acceptedCount} rule${acceptedCount === 1 ? "" : "s"} & continue`
							: "Continue"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
