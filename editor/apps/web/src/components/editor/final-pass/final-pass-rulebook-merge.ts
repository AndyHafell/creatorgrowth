// Merge editor-approved rules from the learning loop into the existing free-text
// rulebook (the v1 "Cut rules" blob injected as LEARNED EDITOR PREFERENCES).
// Pure so it's unit-tested without the editor. De-dupes case- and bullet-
// insensitively so re-running "Teach from this edit" on a similar video doesn't
// stack near-identical lines. Accepted rules are appended as "- " bullets to
// match the v1 dialog's house style.

/** Strip a leading "- " / "* " bullet and surrounding whitespace. */
function stripBullet(line: string): string {
	return line.replace(/^\s*[-*]\s+/, "").trim();
}

export function mergeRules(existing: string, accepted: string[]): string {
	const seen = new Set(
		existing
			.split("\n")
			.map((l) => stripBullet(l).toLowerCase())
			.filter(Boolean),
	);

	const additions: string[] = [];
	for (const raw of accepted) {
		const clean = stripBullet(raw);
		if (!clean) continue;
		const key = clean.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		additions.push(`- ${clean}`);
	}

	if (additions.length === 0) return existing;
	const base = existing.trimEnd();
	return (base ? [base, ...additions] : additions).join("\n");
}
