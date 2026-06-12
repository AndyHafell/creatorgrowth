"use client";

import { useEffect, useState } from "react";

// Shared-account avatar. The editor and main creatorgrowth run on ONE account
// (same login/session, same settings). This shows the member's CG profile
// picture in the editor's top bar and links to the single settings modal on the
// main app (?settings=1), so profile + API keys live in one place as the editor
// grows. Auth-status is same-origin (the editor lives at creatorgrowth.com/editor)
// so the session cookie rides along; an absolute "/api/..." path hits the CG app,
// not the /editor basePath.

function initialsAvatar(seed: string): string {
	const s = (seed || "").trim();
	const letter = (s[0] || "?").toUpperCase();
	let h = 0;
	for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
	const bg = `hsl(${h},42%,40%)`;
	const svg =
		`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>` +
		`<rect width='64' height='64' rx='32' fill='${bg}'/>` +
		`<text x='32' y='43' font-size='30' font-family='system-ui,sans-serif' fill='white' text-anchor='middle'>${letter}</text>` +
		`</svg>`;
	return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

export function MemberAvatar() {
	const [src, setSrc] = useState<string | null>(null);
	const [email, setEmail] = useState("");

	useEffect(() => {
		let cancelled = false;
		fetch("/api/auth-status", { credentials: "include" })
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				if (cancelled || !d) return;
				setEmail(d.email || "");
				const pic: string = d.profile_pic || d.default_avatar || "";
				setSrc(pic || initialsAvatar(d.email || ""));
			})
			.catch(() => {
				/* not signed in / CG unreachable — leave the initials fallback */
			});
		return () => {
			cancelled = true;
		};
	}, []);

	return (
		// Raw <a> + absolute href: navigates to creatorgrowth.com/?settings=1
		// (the shared account settings), bypassing the editor's /editor basePath.
		<a
			href="/?settings=1"
			title="Account & settings"
			className="border-border hover:border-muted-foreground ml-1 inline-flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full border transition-colors"
		>
			{/* biome-ignore lint/a11y/useAltText: decorative account avatar */}
			<img
				src={src || initialsAvatar(email)}
				alt="Account"
				className="size-8 rounded-full object-cover"
			/>
		</a>
	);
}
