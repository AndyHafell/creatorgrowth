import {
	applyCameraToQuad,
	type CameraQuad,
	cameraQuadForZoomProgress,
	highlightLayout,
} from "@/lib/effects/camera";
import {
	createZoomSpringState,
	isZoomSpringAtRest,
	resetZoomSpring,
	stepZoomSpring,
	type ZoomTransform,
} from "@/lib/effects/spring";
import { TICKS_PER_SECOND } from "@/lib/wasm";
import {
	buildGaussianBlurPasses,
	intensityToSigma,
} from "@/lib/effects/definitions/blur";
import { drawCssBackground } from "@/lib/gradients";
import { masksRegistry } from "@/lib/masks";
import type { AnyBaseNode } from "../nodes/base-node";
import type { CanvasRenderer } from "../canvas-renderer";
import { createOffscreenCanvas } from "../canvas-utils";
import { BlurBackgroundNode } from "../nodes/blur-background-node";
import { ColorNode } from "../nodes/color-node";
import {
	EffectLayerNode,
	type ResolvedEffectLayerNodeState,
} from "../nodes/effect-layer-node";
import {
	GraphicNode,
	type ResolvedGraphicNodeState,
} from "../nodes/graphic-node";
import { ImageNode } from "../nodes/image-node";
import { RootNode } from "../nodes/root-node";
import { StickerNode } from "../nodes/sticker-node";
import { renderTextToContext, TextNode } from "../nodes/text-node";
import { VideoNode } from "../nodes/video-node";
import type { ResolvedVisualSourceNodeState } from "../nodes/visual-node";
import type {
	FrameDescriptor,
	FrameItemDescriptor,
	LayerMaskDescriptor,
	QuadTransformDescriptor,
} from "./types";
import { DEFAULT_GRAPHIC_SOURCE_SIZE } from "@/lib/graphics";

export type TextureUploadDescriptor = {
	id: string;
	source: CanvasImageSource;
	width: number;
	height: number;
};

export async function buildFrameDescriptor({
	node,
	renderer,
	time,
}: {
	node: AnyBaseNode;
	renderer: CanvasRenderer;
	/** Frame time in ticks. When provided, the Magic camera spring-chases its target. */
	time?: number;
}): Promise<{
	frame: FrameDescriptor;
	textures: TextureUploadDescriptor[];
}> {
	const items: FrameItemDescriptor[] = [];
	const textures = new Map<string, TextureUploadDescriptor>();

	await collectNode({
		node,
		renderer,
		path: "root",
		items,
		textures,
		time,
	});

	return {
		frame: {
			width: renderer.width,
			height: renderer.height,
			clear: {
				color: [0, 0, 0, 1],
			},
			items,
		},
		textures: [...textures.values()],
	};
}

async function collectNode({
	node,
	renderer,
	path,
	items,
	textures,
	camera = null,
	belowNodes = [],
	time,
}: {
	node: AnyBaseNode;
	renderer: CanvasRenderer;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
	camera?: CameraQuad | null;
	belowNodes?: AnyBaseNode[];
	time?: number;
}): Promise<void> {
	if (node instanceof RootNode) {
		// Topmost active camera wins (spec: last-on-top). It applies to every child BELOW it.
		let cameraNodeIndex = -1;
		let sceneCamera: CameraQuad | null = null;
		for (let index = node.children.length - 1; index >= 0; index--) {
			const child = node.children[index];
			if (child instanceof EffectLayerNode && child.resolved?.camera) {
				sceneCamera = cameraQuadForZoomProgress({
					targetScale: child.resolved.camera.scale,
					focalX: child.resolved.camera.focalX,
					focalY: child.resolved.camera.focalY,
					progress: child.resolved.camera.progress,
					canvasWidth: renderer.width,
					canvasHeight: renderer.height,
				});
				cameraNodeIndex = index;
				break;
			}
		}

		if (time !== undefined) {
			const smoothed = chaseSceneCamera({
				renderer,
				targetQuad: sceneCamera,
				time,
			});
			// the spring may still be settling after the last camera clip ended —
			// then it applies to the whole scene (there is no camera node anymore)
			if (smoothed && cameraNodeIndex === -1) {
				cameraNodeIndex = node.children.length;
			}
			sceneCamera = smoothed;
		}

		for (let index = 0; index < node.children.length; index++) {
			await collectNode({
				node: node.children[index],
				renderer,
				path: `${path}:${index}`,
				items,
				textures,
				camera: index < cameraNodeIndex ? sceneCamera : null,
				belowNodes: node.children.slice(0, index),
			});
		}
		return;
	}

	if (node instanceof ColorNode) {
		const textureId = `${path}:color`;
		const canvas = createOffscreenCanvas({
			width: renderer.width,
			height: renderer.height,
		});
		const ctx = canvas.getContext("2d") as
			| CanvasRenderingContext2D
			| OffscreenCanvasRenderingContext2D
			| null;
		if (!ctx) return;
		if (/gradient\(/i.test(node.params.color)) {
			drawCssBackground({
				ctx,
				width: renderer.width,
				height: renderer.height,
				css: node.params.color,
			});
		} else {
			ctx.fillStyle = node.params.color;
			ctx.fillRect(0, 0, renderer.width, renderer.height);
		}
		textures.set(textureId, {
			id: textureId,
			source: canvas,
			width: renderer.width,
			height: renderer.height,
		});
		items.push({
			type: "layer",
			textureId,
			transform: fullCanvasTransform(renderer),
			opacity: 1,
			blendMode: "normal",
			effectPassGroups: [],
			mask: null,
		});
		return;
	}

	if (node instanceof EffectLayerNode) {
		if (!node.resolved) {
			return;
		}

		if (node.resolved.highlight) {
			// a failing highlight must never take down the whole frame
			try {
				await collectHighlight({
					highlight: node.resolved.highlight,
					renderer,
					path,
					items,
					textures,
					belowNodes,
				});
			} catch (error) {
				console.error("[magic-highlight] emission failed:", error);
			}
			return;
		}

		if (node.resolved.camera) {
			// camera is applied by the RootNode pre-pass; the node itself emits nothing
			return;
		}

		if (node.resolved.passes.length === 0) {
			return;
		}
		items.push({
			type: "sceneEffect",
			effectPassGroups: [node.resolved.passes],
			effect_pass_groups: [node.resolved.passes],
		});
		return;
	}

	if (node instanceof BlurBackgroundNode) {
		if (!node.resolved) {
			return;
		}
		const textureId = `${path}:blur-background`;
		const backdropCanvas = createOffscreenCanvas({
			width: renderer.width,
			height: renderer.height,
		});
		const backdropCtx = backdropCanvas.getContext("2d") as
			| CanvasRenderingContext2D
			| OffscreenCanvasRenderingContext2D
			| null;
		if (!backdropCtx) return;
		const { backdropSource, passes } = node.resolved;
		const coverScale = Math.max(
			renderer.width / backdropSource.width,
			renderer.height / backdropSource.height,
		);
		const scaledWidth = backdropSource.width * coverScale;
		const scaledHeight = backdropSource.height * coverScale;
		const offsetX = (renderer.width - scaledWidth) / 2;
		const offsetY = (renderer.height - scaledHeight) / 2;
		backdropCtx.drawImage(
			backdropSource.source,
			offsetX,
			offsetY,
			scaledWidth,
			scaledHeight,
		);
		textures.set(textureId, {
			id: textureId,
			source: backdropCanvas,
			width: renderer.width,
			height: renderer.height,
		});
		items.push({
			type: "layer",
			textureId,
			transform: fullCanvasTransform(renderer),
			opacity: 1,
			blendMode: "normal",
			effectPassGroups: [passes],
			mask: null,
		});
		return;
	}

	if (
		node instanceof VideoNode ||
		node instanceof ImageNode ||
		node instanceof StickerNode ||
		node instanceof GraphicNode
	) {
		await collectVisualSourceNode({
			node,
			renderer,
			path,
			items,
			textures,
			camera,
		});
		return;
	}

	if (node instanceof TextNode) {
		collectTextNode({
			node,
			renderer,
			path,
			items,
			textures,
			camera,
		});
	}
}

async function collectVisualSourceNode({
	node,
	renderer,
	path,
	items,
	textures,
	camera = null,
}: {
	node: VideoNode | ImageNode | StickerNode | GraphicNode;
	renderer: CanvasRenderer;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
	camera?: CameraQuad | null;
}) {
	if (!node.resolved) {
		return;
	}

	const source =
		node instanceof GraphicNode
			? node.getSource({ resolvedParams: node.resolved.resolvedParams })
			: node.resolved.source;
	if (!source) {
		return;
	}

	const sourceWidth =
		node instanceof GraphicNode
			? DEFAULT_GRAPHIC_SOURCE_SIZE
			: (node.resolved as ResolvedVisualSourceNodeState).sourceWidth;
	const sourceHeight =
		node instanceof GraphicNode
			? DEFAULT_GRAPHIC_SOURCE_SIZE
			: (node.resolved as ResolvedVisualSourceNodeState).sourceHeight;

	const textureId = `${path}:source`;
	textures.set(textureId, {
		id: textureId,
		source,
		width: sourceWidth,
		height: sourceHeight,
	});

	const baseTransform = computeVisualTransform({
		renderer,
		resolved: node.resolved,
		sourceWidth,
		sourceHeight,
	});
	const transform = camera
		? applyCameraToQuad({ quad: baseTransform, camera })
		: baseTransform;
	const { mask, strokeLayer } = buildMaskArtifacts({
		node,
		renderer,
		path,
		transform,
		textures,
	});

	items.push({
		type: "layer",
		textureId,
		transform,
		opacity: node.resolved.opacity,
		blendMode: node.params.blendMode ?? "normal",
		effectPassGroups: node.resolved.effectPasses,
		mask,
	});
	if (strokeLayer) {
		items.push(strokeLayer);
	}
}

function collectTextNode({
	node,
	renderer,
	path,
	items,
	textures,
	camera = null,
}: {
	node: TextNode;
	renderer: CanvasRenderer;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
	camera?: CameraQuad | null;
}) {
	if (!node.resolved) {
		return;
	}

	const textureId = `${path}:text`;
	const canvas = createOffscreenCanvas({
		width: renderer.width,
		height: renderer.height,
	});
	const ctx = canvas.getContext("2d") as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D
		| null;
	if (!ctx) {
		return;
	}

	renderTextToContext({
		node,
		ctx,
	});

	textures.set(textureId, {
		id: textureId,
		source: canvas,
		width: renderer.width,
		height: renderer.height,
	});
	items.push({
		type: "layer",
		textureId,
		transform: camera
			? applyCameraToQuad({ quad: fullCanvasTransform(renderer), camera })
			: fullCanvasTransform(renderer),
		opacity: node.resolved.opacity,
		blendMode: node.params.blendMode ?? "normal",
		effectPassGroups: node.resolved.effectPasses,
		mask: null,
	});
}

/**
 * Spring-chase the scene camera (Screen Studio feel, adapted from OpenScreen).
 * The envelope-shaped quad stays the authored TARGET; a per-axis spring on
 * (scale, crop-window origin) makes the rendered motion velocity-continuous
 * through ease ramps, holds, clip seams and reframe cuts. State lives on the
 * CanvasRenderer (preview and export each own one; deltas are CONTENT time,
 * so export is deterministic and matches preview). Seeks/scrubs snap.
 */
function chaseSceneCamera({
	renderer,
	targetQuad,
	time,
}: {
	renderer: CanvasRenderer;
	targetQuad: CameraQuad | null;
	time: number;
}): CameraQuad | null {
	const target: ZoomTransform = targetQuad
		? {
				scale: targetQuad.scale,
				x: -targetQuad.offsetX / targetQuad.scale,
				y: -targetQuad.offsetY / targetQuad.scale,
			}
		: { scale: 1, x: 0, y: 0 };

	const spring = (renderer.cameraSpring ??= createZoomSpringState());
	const last = renderer.lastCameraTimeTicks;
	renderer.lastCameraTimeTicks = time;
	const dtMs = last === null ? null : ((time - last) / TICKS_PER_SECOND) * 1000;

	// first frame, paused re-render (dt 0), backwards or large jump (seek/scrub):
	// snap — seeking must never animate
	if (dtMs === null || dtMs <= 0 || dtMs > 250) {
		resetZoomSpring(spring, target);
	}

	const smoothed = stepZoomSpring(spring, target, dtMs ?? 1000 / 60);

	if (!targetQuad && isZoomSpringAtRest(spring, target)) {
		return null;
	}

	return {
		scale: smoothed.scale,
		offsetX: -smoothed.x * smoothed.scale + 0,
		offsetY: -smoothed.y * smoothed.scale + 0,
	};
}

async function collectHighlight({
	highlight,
	renderer,
	path,
	items,
	textures,
	belowNodes,
}: {
	highlight: NonNullable<ResolvedEffectLayerNodeState["highlight"]>;
	renderer: CanvasRenderer;
	path: string;
	items: FrameItemDescriptor[];
	textures: Map<string, TextureUploadDescriptor>;
	belowNodes: AnyBaseNode[];
}) {
	const { progress } = highlight;
	if (progress <= 0.001) return;

	// 1. Blur the composite below (existing gaussian shader), scaled by progress
	if (highlight.blurIntensity > 0) {
		const passes = buildGaussianBlurPasses({
			sigmaX: intensityToSigma({
				intensity: highlight.blurIntensity * progress,
				resolution: renderer.width,
				reference: 1920,
			}),
			sigmaY: intensityToSigma({
				intensity: highlight.blurIntensity * progress,
				resolution: renderer.height,
				reference: 1080,
			}),
		});
		if (passes.length > 0) {
			items.push({
				type: "sceneEffect",
				effectPassGroups: [passes],
				effect_pass_groups: [passes],
			});
		}
	}

	// 2. Dim quad over the blurred composite
	if (highlight.dim > 0) {
		const dimTextureId = `${path}:hl-dim`;
		const dimCanvas = createOffscreenCanvas({ width: 2, height: 2 });
		const dimCtx = dimCanvas.getContext("2d") as
			| CanvasRenderingContext2D
			| OffscreenCanvasRenderingContext2D
			| null;
		if (dimCtx) {
			dimCtx.fillStyle = "black";
			dimCtx.fillRect(0, 0, 2, 2);
			textures.set(dimTextureId, {
				id: dimTextureId,
				source: dimCanvas,
				width: 2,
				height: 2,
			});
			items.push({
				type: "layer",
				textureId: dimTextureId,
				transform: fullCanvasTransform(renderer),
				opacity: highlight.dim * progress,
				blendMode: "normal",
				effectPassGroups: [],
				mask: null,
			});
		}
	}

	// 3. The cutout: re-emit the visual layers below with the pop camera + a rounded-rect mask
	const layout = highlightLayout({
		region: highlight.region,
		size: highlight.size,
		progress,
		canvasWidth: renderer.width,
		canvasHeight: renderer.height,
	});

	const maskTextureId = `${path}:hl-mask`;
	const maskCanvas = createOffscreenCanvas({
		width: renderer.width,
		height: renderer.height,
	});
	const maskCtx = maskCanvas.getContext("2d") as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D
		| null;
	if (!maskCtx) return;
	maskCtx.fillStyle = "white";
	const cornerRadius = Math.min(
		highlight.cornerRadius,
		layout.dstRect.w / 2,
		layout.dstRect.h / 2,
	);
	maskCtx.beginPath();
	if (typeof maskCtx.roundRect === "function") {
		maskCtx.roundRect(
			layout.dstRect.x,
			layout.dstRect.y,
			layout.dstRect.w,
			layout.dstRect.h,
			cornerRadius,
		);
	} else {
		maskCtx.rect(
			layout.dstRect.x,
			layout.dstRect.y,
			layout.dstRect.w,
			layout.dstRect.h,
		);
	}
	maskCtx.fill();
	textures.set(maskTextureId, {
		id: maskTextureId,
		source: maskCanvas,
		width: renderer.width,
		height: renderer.height,
	});
	const cutoutMask: LayerMaskDescriptor = {
		textureId: maskTextureId,
		feather: 0,
		inverted: false,
	};

	const cutoutItems: FrameItemDescriptor[] = [];
	for (let i = 0; i < belowNodes.length; i++) {
		const child = belowNodes[i];
		if (
			child instanceof EffectLayerNode ||
			child instanceof ColorNode ||
			child instanceof BlurBackgroundNode
		) {
			continue;
		}
		await collectNode({
			node: child,
			renderer,
			path: `${path}:hl:${i}`,
			items: cutoutItems,
			textures,
			camera: layout.camera,
		});
	}
	for (const item of cutoutItems) {
		if (item.type === "layer") {
			items.push({ ...item, mask: cutoutMask });
		}
	}
}

function computeVisualTransform({
	renderer,
	resolved,
	sourceWidth,
	sourceHeight,
}: {
	renderer: CanvasRenderer;
	resolved: ResolvedVisualSourceNodeState | ResolvedGraphicNodeState;
	sourceWidth: number;
	sourceHeight: number;
}): QuadTransformDescriptor {
	const containScale = Math.min(
		renderer.width / sourceWidth,
		renderer.height / sourceHeight,
	);
	const scaledWidth = sourceWidth * containScale * resolved.transform.scaleX;
	const scaledHeight = sourceHeight * containScale * resolved.transform.scaleY;
	const absWidth = Math.abs(scaledWidth);
	const absHeight = Math.abs(scaledHeight);

	return {
		centerX: renderer.width / 2 + resolved.transform.position.x,
		centerY: renderer.height / 2 + resolved.transform.position.y,
		width: absWidth,
		height: absHeight,
		rotationDegrees: resolved.transform.rotate,
		flipX: scaledWidth < 0,
		flipY: scaledHeight < 0,
	};
}

function fullCanvasTransform(
	renderer: CanvasRenderer,
): QuadTransformDescriptor {
	return {
		centerX: renderer.width / 2,
		centerY: renderer.height / 2,
		width: renderer.width,
		height: renderer.height,
		rotationDegrees: 0,
		flipX: false,
		flipY: false,
	};
}

function buildMaskArtifacts({
	node,
	renderer,
	path,
	transform,
	textures,
}: {
	node: VideoNode | ImageNode | StickerNode | GraphicNode;
	renderer: CanvasRenderer;
	path: string;
	transform: QuadTransformDescriptor;
	textures: Map<string, TextureUploadDescriptor>;
}): {
	mask: LayerMaskDescriptor | null;
	strokeLayer: FrameItemDescriptor | null;
} {
	const mask = node.params.masks?.[0];
	if (!mask) {
		return { mask: null, strokeLayer: null };
	}

	const definition = masksRegistry.get(mask.type);
	const elementMaskCanvas = createOffscreenCanvas({
		width: Math.round(transform.width),
		height: Math.round(transform.height),
	});
	const elementMaskCtx = elementMaskCanvas.getContext("2d") as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D
		| null;
	if (!elementMaskCtx) {
		return { mask: null, strokeLayer: null };
	}
	elementMaskCtx.clearRect(0, 0, transform.width, transform.height);

	let strokePath: Path2D | null = null;
	let feather = mask.params.feather;
	if (mask.params.feather > 0 && definition.renderer.renderMask) {
		definition.renderer.renderMask({
			resolvedParams: mask.params,
			ctx: elementMaskCtx,
			width: Math.round(transform.width),
			height: Math.round(transform.height),
			feather: mask.params.feather,
		});
		feather = 0;
		strokePath =
			definition.renderer.buildStrokePath?.({
				resolvedParams: mask.params,
				width: transform.width,
				height: transform.height,
			}) ?? null;
	} else {
		const path2d = definition.renderer.buildPath({
			resolvedParams: mask.params,
			width: transform.width,
			height: transform.height,
		});
		elementMaskCtx.fillStyle = "white";
		elementMaskCtx.fill(path2d);
		strokePath =
			definition.renderer.buildStrokePath?.({
				resolvedParams: mask.params,
				width: transform.width,
				height: transform.height,
			}) ?? path2d;
	}

	const fullMaskCanvas = createOffscreenCanvas({
		width: renderer.width,
		height: renderer.height,
	});
	const fullMaskCtx = fullMaskCanvas.getContext("2d") as
		| CanvasRenderingContext2D
		| OffscreenCanvasRenderingContext2D
		| null;
	if (!fullMaskCtx) {
		return { mask: null, strokeLayer: null };
	}
	drawTransformedCanvas({
		ctx: fullMaskCtx,
		source: elementMaskCanvas,
		transform,
	});

	const maskTextureId = `${path}:mask`;
	textures.set(maskTextureId, {
		id: maskTextureId,
		source: fullMaskCanvas,
		width: renderer.width,
		height: renderer.height,
	});

	let strokeLayer: FrameItemDescriptor | null = null;
	if (mask.params.strokeWidth > 0 && strokePath) {
		const strokeCanvas = createOffscreenCanvas({
			width: Math.round(transform.width),
			height: Math.round(transform.height),
		});
		const strokeCtx = strokeCanvas.getContext("2d") as
			| CanvasRenderingContext2D
			| OffscreenCanvasRenderingContext2D
			| null;
		if (strokeCtx) {
			strokeCtx.strokeStyle = mask.params.strokeColor;
			strokeCtx.lineWidth = mask.params.strokeWidth;
			strokeCtx.stroke(strokePath);

			const fullStrokeCanvas = createOffscreenCanvas({
				width: renderer.width,
				height: renderer.height,
			});
			const fullStrokeCtx = fullStrokeCanvas.getContext("2d") as
				| CanvasRenderingContext2D
				| OffscreenCanvasRenderingContext2D
				| null;
			if (fullStrokeCtx) {
				drawTransformedCanvas({
					ctx: fullStrokeCtx,
					source: strokeCanvas,
					transform,
				});
				const strokeTextureId = `${path}:mask-stroke`;
				textures.set(strokeTextureId, {
					id: strokeTextureId,
					source: fullStrokeCanvas,
					width: renderer.width,
					height: renderer.height,
				});
				strokeLayer = {
					type: "layer",
					textureId: strokeTextureId,
					transform: fullCanvasTransform(renderer),
					opacity: 1,
					blendMode: "normal",
					effectPassGroups: [],
					mask: null,
				};
			}
		}
	}

	return {
		mask: {
			textureId: maskTextureId,
			feather,
			inverted: mask.params.inverted,
		},
		strokeLayer,
	};
}

function drawTransformedCanvas({
	ctx,
	source,
	transform,
}: {
	ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
	source: CanvasImageSource;
	transform: QuadTransformDescriptor;
}) {
	const x = transform.centerX - transform.width / 2;
	const y = transform.centerY - transform.height / 2;
	const flipX = transform.flipX ? -1 : 1;
	const flipY = transform.flipY ? -1 : 1;
	const requiresTransform =
		transform.rotationDegrees !== 0 || flipX !== 1 || flipY !== 1;

	ctx.save();
	if (requiresTransform) {
		ctx.translate(transform.centerX, transform.centerY);
		ctx.rotate((transform.rotationDegrees * Math.PI) / 180);
		ctx.scale(flipX, flipY);
		ctx.translate(-transform.centerX, -transform.centerY);
	}
	ctx.drawImage(source, x, y, transform.width, transform.height);
	ctx.restore();
}
