"use client";

import { ListChecks } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogBody,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { loadRulebook, saveRulebook } from "./final-pass-cache";

// Part B v1 — the editable "cut rules" rulebook. Plain text the editor injects
// into every first-pass cut prompt as LEARNED EDITOR PREFERENCES, so the AI cuts
// the way Andy wants. Stored in this browser (localStorage); the editor + main CG
// share one account, so a later version can sync it server-side per member.
const PLACEHOLDER = `One rule per line, in your own words. Examples:
- Don't cut deliberate pauses I leave for emphasis.
- Keep the cold-open hook even if the first 10s ramble a bit.
- Be aggressive cutting "um", "like", and false starts.
- Never cut the call-to-action at the end.`;

export function FinalPassRulebook() {
	const [open, setOpen] = useState(false);
	const [text, setText] = useState("");
	const [hasRules, setHasRules] = useState(false);

	// On mount, sync the account rulebook into the local mirror so the analyze()
	// inject path picks up rules saved on another machine (the multi-tenant point).
	useEffect(() => {
		loadRulebook().then((t) => setHasRules(t.trim().length > 0));
	}, []);

	// Opening the dialog re-pulls from the account (freshest text to edit).
	useEffect(() => {
		if (open) loadRulebook().then(setText);
	}, [open]);

	const save = () => {
		saveRulebook(text); // mirror written synchronously; account POST is best-effort
		setHasRules(text.trim().length > 0);
		setOpen(false);
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm" className="gap-1.5">
					<ListChecks className="size-3.5" />
					Cut rules
					{hasRules && <span className="size-1.5 rounded-full bg-green-500" />}
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Cut rules</DialogTitle>
					<DialogDescription>
						Tell the AI how YOU want cuts made. These rules are added to every
						Analyze as “learned editor preferences,” so the first pass matches
						your taste. Stored in this browser.
					</DialogDescription>
				</DialogHeader>
				<DialogBody>
					<Textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						placeholder={PLACEHOLDER}
						rows={10}
						className="font-mono text-sm"
					/>
				</DialogBody>
				<DialogFooter>
					<Button variant="ghost" onClick={() => setOpen(false)}>
						Cancel
					</Button>
					<Button onClick={save}>Save</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
