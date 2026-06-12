import { describe, expect, it } from "bun:test";
import { resolveCardVid, type VidStorage } from "../card-target";

// Minimal localStorage-like fake so resolveCardVid is testable without a DOM.
function fakeStorage(initial: Record<string, string> = {}): VidStorage {
	const map = new Map<string, string>(Object.entries(initial));
	return {
		getItem: (k) => (map.has(k) ? (map.get(k) as string) : null),
		setItem: (k, v) => {
			map.set(k, v);
		},
		get length() {
			return map.size;
		},
		key: (i) => Array.from(map.keys())[i] ?? null,
	};
}

describe("resolveCardVid", () => {
	it("returns the direct cg:vid-for-project mapping when present", () => {
		const storage = fakeStorage({ "cg:vid-for-project:proj-1": "42" });
		expect(resolveCardVid({ projectId: "proj-1", storage })).toBe("42");
	});

	it("falls back to scanning cg:project-for-vid and backfills the direct key", () => {
		const storage = fakeStorage({ "cg:project-for-vid:99": "proj-1" });
		expect(resolveCardVid({ projectId: "proj-1", storage })).toBe("99");
		// Backfill: a second call should hit the fast direct path.
		expect(storage.getItem("cg:vid-for-project:proj-1")).toBe("99");
	});

	it("returns null when no mapping exists for the project", () => {
		const storage = fakeStorage({ "cg:project-for-vid:99": "other-proj" });
		expect(resolveCardVid({ projectId: "proj-1", storage })).toBeNull();
	});

	it("returns null when projectId is empty or null", () => {
		const storage = fakeStorage({ "cg:vid-for-project:proj-1": "42" });
		expect(resolveCardVid({ projectId: "", storage })).toBeNull();
		expect(resolveCardVid({ projectId: null, storage })).toBeNull();
	});
});
