// Magic AutoPass (Agent 9) — shared shapes for the auto-generated effect plan.
// All times are TIMELINE seconds unless a name says otherwise; conversion to
// ticks happens only in planClipToElementSpec so every other module stays
// loadable under bun test (no opencut-wasm import).

/** Word with timeline-time coordinates (already mapped through cuts/trims). */
export interface TimelineWord {
	text: string;
	start: number;
	end: number;
}

export type MagicKind = "zoom" | "highlight" | "reframe";

/** One auto-detected moment worth a Magic clip, before density rules. */
export interface BeatCandidate {
	kind: MagicKind;
	/** Timeline seconds of the trigger phrase. */
	triggerStart: number;
	triggerEnd: number;
	/** Human-readable why — surfaces on the clip name for review. */
	reason: string;
	/** Percent-space focal bias from direction words, when present. */
	focalHint: { x: number; y: number } | null;
	/** 2 = strong trigger phrase, 1 = weak. */
	strength: number;
}

/** Final plan clip — the schema from the hyperedit-layer spec (Phase 2). */
export interface MagicPlanClip {
	kind: MagicKind;
	start: number;
	end: number;
	scale: number;
	focalX: number;
	focalY: number;
	/** Highlight only — percent space, like the magic-highlight params. */
	region?: { x: number; y: number; w: number; h: number };
	easeIn: number;
	easeOut: number;
	reason: string;
	/** Director-set: the clip's visible content is a web browser window. */
	browser?: boolean;
}

export interface MagicPlan {
	clips: MagicPlanClip[];
}

/**
 * Frame cap for the vision director — lives here (not refine.ts) so the
 * client can import it without pulling server-only code into the bundle.
 * v2 samples the scope on a fixed grid (~4.5s) instead of one per clip, so
 * the cap is higher; directorFrameTimes widens the step on long scopes.
 */
export const MAX_REFINE_FRAMES = 32;

/** What the client needs to build one EffectElement (ticks + param overrides). */
export interface MagicElementSpec {
	effectType: "magic-zoom" | "magic-highlight" | "magic-reframe";
	/** Ticks. */
	startTime: number;
	/** Ticks. */
	duration: number;
	params: Record<string, number | string>;
	name: string;
}
