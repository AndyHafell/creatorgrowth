import type { ParamDefinition, ParamValues } from "@/lib/params";

export interface Effect {
	id: string;
	type: string;
	params: ParamValues;
	enabled: boolean;
}

export type EffectUniformValue = number | number[];

export interface EffectPass {
	shader: string;
	uniforms: Record<string, EffectUniformValue>;
}

export interface EffectPassTemplate {
	shader: string;
	uniforms(params: {
		effectParams: ParamValues;
		width: number;
		height: number;
	}): Record<string, EffectUniformValue>;
}

export interface EffectRendererConfig {
	passes: EffectPassTemplate[];
	buildPasses?: (params: {
		effectParams: ParamValues;
		width: number;
		height: number;
	}) => EffectPass[];
}

export type EffectKind = "passes" | "camera" | "highlight";

export interface ResolvedCameraState {
	/** TARGET zoom level — the envelope's progress drives how much of it applies */
	scale: number;
	/** 0-1 frame space */
	focalX: number;
	/** 0-1 frame space */
	focalY: number;
	/** zoom envelope progress 0-1 at the resolved time */
	progress: number;
}

export interface ResolvedHighlightState {
	/** normalized 0-1 frame space */
	region: { x: number; y: number; w: number; h: number };
	/** fraction of the frame the cutout fills at full pop, 0-1 */
	size: number;
	/** pop envelope, 0-1 */
	progress: number;
	/** background darkening, 0-1 */
	dim: number;
	/** background blur, same 0-100 unit as the blur effect */
	blurIntensity: number;
	/** cutout rounding in canvas px */
	cornerRadius: number;
}

export interface EffectTimeContext {
	effectParams: ParamValues;
	/** clip-local time in ticks */
	localTime: number;
	/** clip duration in ticks */
	duration: number;
	ticksPerSecond: number;
}

export interface EffectDefinition {
	type: string;
	name: string;
	keywords: string[];
	params: ParamDefinition[];
	renderer: EffectRendererConfig;
	/** "passes" (default) = shader passes; "camera" = transforms layers below; "highlight" = pop-out cutout */
	kind?: EffectKind;
	resolveCamera?: (params: EffectTimeContext) => ResolvedCameraState | null;
	resolveHighlight?: (
		params: EffectTimeContext,
	) => ResolvedHighlightState | null;
}
