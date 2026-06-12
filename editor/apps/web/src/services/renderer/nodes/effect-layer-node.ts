import type {
	EffectPass,
	ResolvedCameraState,
	ResolvedHighlightState,
} from "@/lib/effects/types";
import type { ParamValues } from "@/lib/params";
import { BaseNode } from "./base-node";

export type EffectLayerNodeParams = {
	effectType: string;
	effectParams: ParamValues;
	timeOffset: number;
	duration: number;
};

export type ResolvedEffectLayerNodeState = {
	passes: EffectPass[];
	camera?: ResolvedCameraState | null;
	highlight?: ResolvedHighlightState | null;
};

export class EffectLayerNode extends BaseNode<
	EffectLayerNodeParams,
	ResolvedEffectLayerNodeState
> {}
