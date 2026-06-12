"use client";

import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
import {
	API_KEYS_CHANGED_EVENT,
	getStoredKey,
	setStoredKey,
} from "@/lib/final-pass/api-keys";

// BYO-key settings for Final Pass AI. Keys live only in this browser and are
// sent per-request so analysis/transcription run on the member's own quota.
export function FinalPassKeys() {
	const [open, setOpen] = useState(false);
	const [gemini, setGemini] = useState("");
	const [eleven, setEleven] = useState("");
	const [hasGemini, setHasGemini] = useState(false);

	// Track whether a Gemini key exists so the button can flag when it's missing
	// (analysis can't run without it).
	useEffect(() => {
		const sync = () => setHasGemini(getStoredKey("gemini").length > 0);
		sync();
		window.addEventListener(API_KEYS_CHANGED_EVENT, sync);
		return () => window.removeEventListener(API_KEYS_CHANGED_EVENT, sync);
	}, []);

	// Load current values when the dialog opens.
	useEffect(() => {
		if (open) {
			setGemini(getStoredKey("gemini"));
			setEleven(getStoredKey("eleven"));
		}
	}, [open]);

	const save = () => {
		setStoredKey("gemini", gemini);
		setStoredKey("eleven", eleven);
		setOpen(false);
	};

	return (
		<Dialog open={open} onOpenChange={setOpen}>
			<DialogTrigger asChild>
				<Button variant="outline" size="sm" className="gap-1.5">
					<KeyRound className="size-3.5" />
					API keys
					{!hasGemini && (
						<span className="bg-destructive size-1.5 rounded-full" />
					)}
				</Button>
			</DialogTrigger>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>Final Pass API keys</DialogTitle>
					<DialogDescription>
						Bring your own keys. They’re stored only in this browser and used to
						run the AI on your own account — nothing is sent to our servers
						except the request itself.
					</DialogDescription>
				</DialogHeader>
				<DialogBody className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="gemini-key">
							Gemini API key{" "}
							<span className="text-muted-foreground">
								(required — analysis & chapters)
							</span>
						</Label>
						<Input
							id="gemini-key"
							type="password"
							autoComplete="off"
							placeholder="AIza…"
							value={gemini}
							onChange={(e) => setGemini(e.target.value)}
						/>
						<a
							href="https://aistudio.google.com/app/apikey"
							target="_blank"
							rel="noopener noreferrer"
							className="text-muted-foreground hover:text-foreground text-xs underline"
						>
							Get a free key at aistudio.google.com
						</a>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="eleven-key">
							ElevenLabs API key{" "}
							<span className="text-muted-foreground">
								(optional — word-accurate transcription; without it, the free
								in-browser model is used)
							</span>
						</Label>
						<Input
							id="eleven-key"
							type="password"
							autoComplete="off"
							placeholder="sk_…"
							value={eleven}
							onChange={(e) => setEleven(e.target.value)}
						/>
						<a
							href="https://elevenlabs.io/app/settings/api-keys"
							target="_blank"
							rel="noopener noreferrer"
							className="text-muted-foreground hover:text-foreground text-xs underline"
						>
							Get a key at elevenlabs.io
						</a>
					</div>
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
