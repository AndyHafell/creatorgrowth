import type { EditorCore } from "@/core";
import { toast } from "sonner";
import type { MediaAsset } from "@/lib/media/types";
import { storageService } from "@/services/storage/service";
import { generateUUID } from "@/utils/id";
import { videoCache } from "@/services/video-cache/service";
import { BatchCommand, RemoveMediaAssetCommand } from "@/lib/commands";
import { hasMediaId } from "@/lib/timeline/element-utils";

export class MediaManager {
	private assets: MediaAsset[] = [];
	private isLoading = false;
	private listeners = new Set<() => void>();

	constructor(private editor: EditorCore) {}

	// Recovery: a media id that timeline clips still reference but that's no
	// longer in the asset list (a "media asset missing" orphan — e.g. the browser
	// evicted the source file after a crash). Returns the id to re-adopt so a
	// re-imported file re-links the existing cuts instead of orphaning them.
	// Prefers a clip whose name matches the imported file; otherwise, if there's
	// exactly ONE missing source on the whole timeline, adopts that (unambiguous).
	private findOrphanedMediaId({ name }: { name: string }): string | null {
		try {
			const present = new Set(this.assets.map((a) => a.id));
			const tracks = this.editor.scenes.getActiveScene().tracks;
			const orphans = new Set<string>();
			let nameMatch: string | null = null;
			for (const track of [...tracks.overlay, tracks.main, ...tracks.audio]) {
				for (const el of track.elements) {
					if (!hasMediaId(el) || present.has(el.mediaId)) continue;
					orphans.add(el.mediaId);
					if (el.name === name) nameMatch = el.mediaId;
				}
			}
			if (nameMatch) return nameMatch;
			if (orphans.size === 1) return [...orphans][0];
		} catch {
			/* no active scene yet — nothing to relink */
		}
		return null;
	}

	async addMediaAsset({
		projectId,
		asset,
	}: {
		projectId: string;
		asset: Omit<MediaAsset, "id">;
	}): Promise<MediaAsset | null> {
		// Re-adopt a missing source's id when re-importing so existing cuts
		// re-link (see findOrphanedMediaId); fall back to a fresh id.
		const adoptedId = this.findOrphanedMediaId({ name: asset.name });
		const newAsset: MediaAsset = {
			...asset,
			id: adoptedId ?? generateUUID(),
		};

		this.assets = [...this.assets, newAsset];
		this.notify();

		try {
			await storageService.saveMediaAsset({ projectId, mediaAsset: newAsset });
			this.editor.project.ratchetFpsForImportedMedia({
				importedAssets: [newAsset],
			});
			return newAsset;
		} catch (error) {
			console.error("Failed to save media asset:", error);
			this.assets = this.assets.filter((asset) => asset.id !== newAsset.id);
			this.notify();

			if (storageService.isQuotaExceededError({ error })) {
				toast.error("Not enough browser storage", {
					description: error instanceof Error ? error.message : undefined,
				});
			}

			return null;
		}
	}

	removeMediaAsset({ projectId, id }: { projectId: string; id: string }): void {
		this.removeMediaAssets({ projectId, ids: [id] });
	}

	removeMediaAssets({
		projectId,
		ids,
	}: {
		projectId: string;
		ids: string[];
	}): void {
		const uniqueIds = [...new Set(ids)];
		if (uniqueIds.length === 0) {
			return;
		}

		const command =
			uniqueIds.length === 1
				? new RemoveMediaAssetCommand(projectId, uniqueIds[0])
				: new BatchCommand(
						uniqueIds.map((id) => new RemoveMediaAssetCommand(projectId, id)),
					);

		this.editor.command.execute({ command });
	}

	async loadProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		this.isLoading = true;
		this.notify();

		try {
			const mediaAssets = await storageService.loadAllMediaAssets({
				projectId,
			});
			this.assets = mediaAssets;
			this.notify();
		} catch (error) {
			console.error("Failed to load media assets:", error);
		} finally {
			this.isLoading = false;
			this.notify();
		}
	}

	async clearProjectMedia({ projectId }: { projectId: string }): Promise<void> {
		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
		});

		const mediaIds = this.assets.map((asset) => asset.id);
		this.assets = [];
		this.notify();

		try {
			await Promise.all(
				mediaIds.map((id) =>
					storageService.deleteMediaAsset({ projectId, id }),
				),
			);
		} catch (error) {
			console.error("Failed to clear media assets from storage:", error);
		}
	}

	clearAllAssets(): void {
		videoCache.clearAll();

		this.assets.forEach((asset) => {
			if (asset.url) {
				URL.revokeObjectURL(asset.url);
			}
			if (asset.thumbnailUrl) {
				URL.revokeObjectURL(asset.thumbnailUrl);
			}
		});

		this.assets = [];
		this.notify();
	}

	getAssets(): MediaAsset[] {
		return this.assets;
	}

	setAssets({ assets }: { assets: MediaAsset[] }): void {
		this.assets = assets;
		this.notify();
	}

	isLoadingMedia(): boolean {
		return this.isLoading;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		this.listeners.forEach((fn) => {
			fn();
		});
	}
}
