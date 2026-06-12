import type { TrackType } from "@/lib/timeline";

export const TIMELINE_TRACK_THEME: Record<
	TrackType,
	{
		elementClassName: string;
		waveformColor?: string;
	}
> = {
	video: { elementClassName: "transparent" },
	text: { elementClassName: "bg-[#5DBAA0]" },
	audio: {
		elementClassName: "bg-[#8F5DBA]",
		waveformColor: "rgba(255, 255, 255, 0.85)",
	},
	graphic: { elementClassName: "bg-[#BA5D7A]" },
	effect: { elementClassName: "bg-[#5d93ba]" },
} as const;

export const SELECTED_TRACK_ROW_CLASS = "bg-accent/50";
export const DEFAULT_TIMELINE_BOOKMARK_COLOR = "#009dff";

export function getTimelineElementClassName({
	type,
}: {
	type: TrackType;
}): string {
	return TIMELINE_TRACK_THEME[type].elementClassName.trim();
}

// Magic clips share the effect-track blue family but each kind gets its own
// shade so a shot list reads at a glance: muted slate for the resting
// reframes, vivid blue for zoom punches, light sky for text highlights.
const EFFECT_KIND_CLASSNAMES: Record<string, string> = {
	"magic-reframe": "bg-[#56809f]",
	"magic-zoom": "bg-[#4694e0]",
	"magic-highlight": "bg-[#62b6d4]",
};

export function getEffectElementClassName({
	effectType,
}: {
	effectType: string;
}): string {
	return (
		EFFECT_KIND_CLASSNAMES[effectType] ??
		TIMELINE_TRACK_THEME.effect.elementClassName.trim()
	);
}
