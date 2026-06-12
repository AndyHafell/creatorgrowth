"use client";

import { useEffect, useRef, useCallback } from "react";
import { PanelView } from "@/components/editor/panels/assets/views/base-panel";
import { DraggableItem } from "@/components/editor/panels/assets/draggable-item";
import { effectsRegistry, EFFECT_TARGET_ELEMENT_TYPES } from "@/lib/effects";
import { effectPreviewService } from "@/services/renderer/effect-preview";
import { HugeiconsIcon } from "@hugeicons/react";
import {
	MagicWand05Icon,
	ZoomInAreaIcon,
	ZoomSquareIcon,
} from "@hugeicons/core-free-icons";
import { useEditor } from "@/hooks/use-editor";
import { buildEffectElement } from "@/lib/timeline/element-utils";
import type { EffectDefinition } from "@/lib/effects/types";

function isMagicKind(effect: EffectDefinition): boolean {
	const kind = effect.kind ?? "passes";
	return kind === "camera" || kind === "highlight";
}

export function EffectsView() {
	const all = effectsRegistry.getAll();
	const magicEffects = all.filter(isMagicKind);
	const passEffects = all.filter((effect) => !isMagicKind(effect));

	return (
		<PanelView title="Effects">
			{magicEffects.length > 0 && (
				<div className="mb-3">
					<div className="mb-2 text-xs font-medium text-muted-foreground">
						Magic Zoom
					</div>
					<EffectsGrid effects={magicEffects} />
				</div>
			)}
			{passEffects.length > 0 && (
				<div>
					{magicEffects.length > 0 && (
						<div className="mb-2 text-xs font-medium text-muted-foreground">
							Effects
						</div>
					)}
					<EffectsGrid effects={passEffects} />
				</div>
			)}
		</PanelView>
	);
}

function EffectsGrid({ effects }: { effects: EffectDefinition[] }) {
	return (
		<div
			className="grid gap-2"
			style={{ gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))" }}
		>
			{effects.map((effect) => (
				<EffectItem key={effect.type} effect={effect} />
			))}
		</div>
	);
}

function MagicEffectPreview({ effect }: { effect: EffectDefinition }) {
	const icon =
		effect.type === "magic-zoom"
			? ZoomInAreaIcon
			: effect.type === "magic-reframe"
				? ZoomSquareIcon
				: MagicWand05Icon;
	return (
		<div className="flex size-full items-center justify-center bg-gradient-to-br from-amber-500/25 to-amber-700/40">
			<HugeiconsIcon icon={icon} className="size-6 text-amber-300" />
		</div>
	);
}

function EffectPreviewCanvas({ effectType }: { effectType: string }) {
	const canvasRef = useRef<HTMLCanvasElement>(null);

	useEffect(() => {
		const render = () => {
			if (canvasRef.current) {
				effectPreviewService.renderPreview({
					effectType,
					params: {},
					targetCanvas: canvasRef.current,
				});
			}
		};

		render();
		return effectPreviewService.onPreviewImageReady({ callback: render });
	}, [effectType]);

	return <canvas ref={canvasRef} className="size-full" />;
}

function EffectItem({ effect }: { effect: EffectDefinition }) {
	const editor = useEditor();

	const handleAddToTimeline = useCallback(() => {
		const currentTime = editor.playback.getCurrentTime();
		const element = buildEffectElement({
			effectType: effect.type,
			startTime: currentTime,
		});

		editor.timeline.insertElement({
			placement: { mode: "auto", trackType: "effect" },
			element,
		});
	}, [editor, effect.type]);

	const magic = isMagicKind(effect);
	const preview = magic ? (
		<MagicEffectPreview effect={effect} />
	) : (
		<EffectPreviewCanvas effectType={effect.type} />
	);

	return (
		<DraggableItem
			name={effect.name}
			preview={preview}
			dragData={{
				id: effect.type,
				name: effect.name,
				type: "effect",
				effectType: effect.type,
				// magic effects transform the whole scene — timeline-only, never dropped onto a clip
				targetElementTypes: magic ? [] : EFFECT_TARGET_ELEMENT_TYPES,
			}}
			onAddToTimeline={handleAddToTimeline}
			aspectRatio={1}
			isRounded
			variant="card"
			containerClassName="w-full"
		/>
	);
}
