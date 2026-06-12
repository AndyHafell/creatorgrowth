"use client";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { SilenceDetectionParams } from "@/lib/media/audio";

interface DetectionKnobsProps {
	params: SilenceDetectionParams;
	onChange: (next: SilenceDetectionParams) => void;
	onUpdate: () => void;
	running: boolean;
}

const FIELDS: Array<{
	key: keyof SilenceDetectionParams;
	label: string;
	unit: string;
	step: number;
	min?: number;
	max?: number;
}> = [
	{ key: "thresholdDb", label: "Filter Below Sound Level", unit: "dB", step: 1, min: -90, max: 0 },
	{ key: "minSilenceSec", label: "Remove Silences Longer Than", unit: "s", step: 0.05, min: 0 },
	{ key: "ignoreShorterKeepsSec", label: "Ignore Detections Shorter Than", unit: "s", step: 0.05, min: 0 },
	{ key: "leftPadSec", label: "Left Padding", unit: "s", step: 0.01, min: 0 },
	{ key: "rightPadSec", label: "Right Padding", unit: "s", step: 0.01, min: 0 },
];

export function DetectionKnobs({
	params,
	onChange,
	onUpdate,
	running,
}: DetectionKnobsProps) {
	const setField = (key: keyof SilenceDetectionParams, raw: string) => {
		const n = Number(raw);
		if (!Number.isFinite(n)) return;
		onChange({ ...params, [key]: n });
	};

	return (
		<div className="flex flex-wrap items-end gap-3">
			{FIELDS.map((f) => (
				<label key={f.key} className="flex flex-col gap-1 text-xs">
					<span className="text-muted-foreground whitespace-nowrap">
						{f.label} ({f.unit})
					</span>
					<Input
						type="number"
						value={params[f.key] ?? 0}
						step={f.step}
						min={f.min}
						max={f.max}
						onChange={(e) => setField(f.key, e.target.value)}
						className="h-8 w-28"
					/>
				</label>
			))}
			<Button onClick={onUpdate} disabled={running} size="sm" className="h-8">
				{running ? "Updating…" : "UPDATE silence detection"}
			</Button>
		</div>
	);
}
