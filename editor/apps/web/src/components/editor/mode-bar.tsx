"use client";

import { HugeiconsIcon } from "@hugeicons/react";
import {
	PenTool03Icon,
	ScissorIcon,
	SparklesIcon,
} from "@hugeicons/core-free-icons";
import {
	type EditorMode,
	useEditorModeStore,
} from "@/stores/editor-mode-store";
import { cn } from "@/utils/ui";

const MODES: Array<{
	id: EditorMode;
	label: string;
	icon: typeof PenTool03Icon;
}> = [
	{ id: "raw-cut", label: "Raw Cut", icon: ScissorIcon },
	{ id: "edit", label: "Edit", icon: PenTool03Icon },
	{ id: "final-pass", label: "Final Pass", icon: SparklesIcon },
];

export function ModeBar() {
	const mode = useEditorModeStore((s) => s.mode);
	const setMode = useEditorModeStore((s) => s.setMode);

	return (
		<div className="bg-background border-t flex h-10 shrink-0 items-center justify-center gap-1 px-3">
			{MODES.map((m) => {
				const active = mode === m.id;
				return (
					<button
						key={m.id}
						type="button"
						onClick={() => setMode(m.id)}
						className={cn(
							"flex h-8 items-center gap-2 rounded-md px-4 text-sm font-medium transition-colors",
							active
								? "bg-primary text-primary-foreground"
								: "text-muted-foreground hover:bg-accent hover:text-foreground",
						)}
					>
						<HugeiconsIcon icon={m.icon} className="size-4" />
						{m.label}
					</button>
				);
			})}
		</div>
	);
}
