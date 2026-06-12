import type { BlendMode } from "@/lib/rendering";
import type { EffectPass } from "@/lib/effects/types";

export type FrameDescriptor = {
	width: number;
	height: number;
	clear: {
		color: [number, number, number, number];
	};
	items: FrameItemDescriptor[];
};

export type FrameItemDescriptor =
	| {
			type: "layer";
			textureId: string;
			transform: QuadTransformDescriptor;
			opacity: number;
			blendMode: BlendMode;
			effectPassGroups: EffectPass[][];
			mask: LayerMaskDescriptor | null;
	  }
	| {
			type: "sceneEffect";
			effectPassGroups: EffectPass[][];
			/**
			 * Same data, snake_case. The Rust FrameItemDescriptor enum camelCases
			 * its variant tag but NOT struct-variant fields (serde rename_all does
			 * not reach them), so deserialization requires `effect_pass_groups`.
			 * Omitting it rejects the entire frame: "missing field
			 * `effect_pass_groups`". See rust/crates/compositor/src/frame.rs.
			 */
			effect_pass_groups: EffectPass[][];
	  };

export type QuadTransformDescriptor = {
	centerX: number;
	centerY: number;
	width: number;
	height: number;
	rotationDegrees: number;
	flipX: boolean;
	flipY: boolean;
};

export type LayerMaskDescriptor = {
	textureId: string;
	feather: number;
	inverted: boolean;
};
