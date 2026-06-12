// Resolve which creatorgrowth card (vid) a given editor project belongs to.
//
// The from-card bridge stores `cg:vid-for-project:${projectId}` → vid when it
// opens the editor from a card, and `cg:project-for-vid:${vid}` → projectId in
// the reverse direction. This mirrors the resolution already used by the Screen
// Share panel (panels/assets/views/screen-share.tsx) so Export attaches the
// render to the same card the editor was opened from.

const LS_VID_FOR_PROJECT = (projectId: string) =>
	`cg:vid-for-project:${projectId}`;
const LS_PROJECT_FOR_VID_PREFIX = "cg:project-for-vid:";

// The slice of the localStorage API we actually need — kept explicit so the
// resolver is unit-testable without a DOM.
export interface VidStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
	readonly length: number;
	key(index: number): string | null;
}

export function resolveCardVid({
	projectId,
	storage,
}: {
	projectId: string | null;
	storage: VidStorage;
}): string | null {
	if (!projectId) return null;

	const direct = storage.getItem(LS_VID_FOR_PROJECT(projectId));
	if (direct) return direct;

	for (let i = 0; i < storage.length; i++) {
		const key = storage.key(i);
		if (!key?.startsWith(LS_PROJECT_FOR_VID_PREFIX)) continue;
		if (storage.getItem(key) === projectId) {
			const found = key.slice(LS_PROJECT_FOR_VID_PREFIX.length);
			// Backfill the fast direct mapping for next time.
			storage.setItem(LS_VID_FOR_PROJECT(projectId), found);
			return found;
		}
	}
	return null;
}
