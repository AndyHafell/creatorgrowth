import { effectsRegistry } from "../registry";
import { blurEffectDefinition } from "./blur";
import { magicHighlightEffectDefinition } from "./magic-highlight";
import { magicReframeEffectDefinition } from "./magic-reframe";
import { magicZoomEffectDefinition } from "./magic-zoom";

const defaultEffects = [
	magicZoomEffectDefinition,
	magicHighlightEffectDefinition,
	magicReframeEffectDefinition,
	blurEffectDefinition,
];

export function registerDefaultEffects(): void {
	for (const definition of defaultEffects) {
		if (effectsRegistry.has(definition.type)) {
			continue;
		}
		effectsRegistry.register(definition.type, definition);
	}
}
