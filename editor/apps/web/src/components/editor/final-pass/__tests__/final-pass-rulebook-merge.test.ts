import { describe, expect, it } from "bun:test";
import { mergeRules } from "../final-pass-rulebook-merge";

describe("mergeRules", () => {
	it("seeds an empty rulebook with a bulleted rule", () => {
		expect(mergeRules("", ["Keep the cold-open hook"])).toBe(
			"- Keep the cold-open hook",
		);
	});

	it("appends new rules under the existing ones", () => {
		expect(
			mergeRules("- Cut all filler\n- Keep CTAs", ["Keep deliberate pauses"]),
		).toBe("- Cut all filler\n- Keep CTAs\n- Keep deliberate pauses");
	});

	it("de-dupes case- and bullet-insensitively against existing rules", () => {
		expect(mergeRules("- Keep the hook", ["keep the hook"])).toBe(
			"- Keep the hook",
		);
		expect(mergeRules("Keep the hook", ["- KEEP THE HOOK"])).toBe(
			"Keep the hook",
		);
	});

	it("adds only the non-duplicate rules from a batch", () => {
		expect(
			mergeRules("- Keep the hook", [
				"keep the hook",
				"Be aggressive on um/uh",
			]),
		).toBe("- Keep the hook\n- Be aggressive on um/uh");
	});

	it("returns the rulebook unchanged when every accepted rule is a duplicate", () => {
		const existing = "- Keep the hook\n- Cut tangents";
		expect(mergeRules(existing, ["Cut tangents"])).toBe(existing);
	});
});
