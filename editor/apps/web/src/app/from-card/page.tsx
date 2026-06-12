"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { EditorCore } from "@/core";
import { processMediaAssets } from "@/lib/media/processing";
import { useEditorModeStore } from "@/stores/editor-mode-store";

type BootstrapAsset = {
	id: string;
	type: string;
	name: string;
	url: string;
	duration: number;
};

type BootstrapDoc = { text: string; rel_path: string };

type CardVideo = {
	available: boolean;
	filename: string;
	size: number | null;
	direct_url?: string;
};

const fmtMb = (bytes: number) => {
	const mb = bytes / 1024 / 1024;
	return mb >= 1024 ? `${(mb / 1024).toFixed(2)} GB` : `${mb.toFixed(0)} MB`;
};

// Download with live progress (res.blob() shows nothing for minutes on a
// multi-GB file). Tries each URL in order — direct NAS first (faster), then
// the same-origin /video-file proxy.
async function downloadWithProgress({
	urls,
	sizeHint,
	setStatus,
}: {
	urls: string[];
	sizeHint: number | null;
	setStatus: (s: string) => void;
}): Promise<Blob> {
	let lastErr: Error = new Error("No download URL available.");
	for (const url of urls) {
		try {
			const sameOrigin = url.startsWith("/");
			const res = await fetch(
				url,
				sameOrigin ? { credentials: "include" } : undefined,
			);
			if (!res.ok) throw new Error(`Video download failed (${res.status}).`);
			const total = Number(res.headers.get("Content-Length")) || sizeHint || 0;
			if (!res.body) return await res.blob();
			const reader = res.body.getReader();
			const chunks: BlobPart[] = [];
			let received = 0;
			let lastTick = 0;
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				chunks.push(value);
				received += value.byteLength;
				const now = performance.now();
				if (now - lastTick > 250) {
					lastTick = now;
					const pct = total
						? ` (${Math.min(100, Math.round((received / total) * 100))}%)`
						: "";
					setStatus(
						`Downloading card video — ${fmtMb(received)}${total ? ` / ${fmtMb(total)}` : ""}${pct}`,
					);
				}
			}
			return new Blob(chunks, {
				type: res.headers.get("Content-Type") || "video/mp4",
			});
		} catch (e) {
			console.warn("card video download failed via", url, e);
			lastErr = e as Error;
		}
	}
	throw lastErr;
}

type BootstrapPayload = {
	vid: number;
	video_id: string;
	title: string;
	content_doc: BootstrapDoc;
	bullet_doc: BootstrapDoc;
	assets: BootstrapAsset[];
	card_video?: CardVideo;
};

const LS_PROJECT_KEY = (vid: string | number) => `cg:project-for-vid:${vid}`;
const LS_VID_FOR_PROJECT_KEY = (projectId: string) =>
	`cg:vid-for-project:${projectId}`;
const LS_CONTENT_DOC_KEY = (vid: string | number) => `cg:content-doc:${vid}`;
const LS_BULLET_DOC_KEY = (vid: string | number) => `cg:bullet-doc:${vid}`;
const LS_CONTENT_DOC_PATH_KEY = (vid: string | number) =>
	`cg:content-doc-path:${vid}`;
const LS_BULLET_DOC_PATH_KEY = (vid: string | number) =>
	`cg:bullet-doc-path:${vid}`;

// Send-to-Final-Pass (?mode=final-pass): make sure the card's uploaded video
// (the publish-section mp4) is in the project's media bin, then point the
// editor's Final Pass page at it. Dedupes by filename so revisits skip the
// (potentially multi-GB) download.
async function sendToFinalPass({
	editor,
	projectId,
	vid,
	cardVideo,
	setStatus,
}: {
	editor: EditorCore;
	projectId: string;
	vid: string;
	cardVideo: CardVideo | undefined;
	setStatus: (s: string) => void;
}): Promise<void> {
	const modeStore = useEditorModeStore.getState();
	if (!cardVideo?.available) {
		// No uploaded video on the card — still land on Final Pass; the clip
		// picker handles the empty/manual case.
		modeStore.setMode("final-pass");
		return;
	}
	const safeName = cardVideo.filename.replace(/[^\w.-]+/g, "_");
	const existing = editor.media
		.getAssets()
		.find((m) => !m.ephemeral && m.type === "video" && m.name === safeName);
	if (existing) {
		modeStore.openInFinalPass(existing.id);
		return;
	}
	setStatus(
		`Downloading card video${cardVideo.size ? ` (${fmtMb(cardVideo.size)})` : ""}…`,
	);
	const urls = [
		...(cardVideo.direct_url ? [cardVideo.direct_url] : []),
		`/api/videos/${vid}/video-file`,
	];
	const blob = await downloadWithProgress({
		urls,
		sizeHint: cardVideo.size,
		setStatus,
	});
	setStatus("Importing video into media bin… (generating thumbnail, ~30s)");
	const file = new File([blob], safeName, {
		type: blob.type || "video/mp4",
	});
	const processed = await processMediaAssets({ files: [file] });
	let mediaId: string | null = null;
	for (const asset of processed) {
		const added = await editor.media.addMediaAsset({ projectId, asset });
		if (added) mediaId = added.id;
	}
	if (!mediaId) throw new Error("Could not add the video to the media bin.");
	modeStore.openInFinalPass(mediaId);
}

export default function FromCardPage() {
	return (
		<Suspense fallback={<BridgeShell status="Loading…" />}>
			<FromCardBridge />
		</Suspense>
	);
}

function BridgeShell({
	status,
	error,
}: {
	status?: string;
	error?: string | null;
}) {
	return (
		<div className="bg-background flex h-screen w-screen items-center justify-center">
			<div className="max-w-md text-center text-sm text-muted-foreground">
				{error ? (
					<>
						<div className="mb-2 text-base font-medium text-foreground">
							Couldn&apos;t open the editor
						</div>
						<div className="mb-4">{error}</div>
						<a
							href="/projects"
							className="text-foreground underline underline-offset-4"
						>
							Open project list
						</a>
					</>
				) : (
					<>
						<div className="mb-3 inline-block size-5 animate-spin rounded-full border-2 border-foreground/30 border-t-foreground" />
						<div>{status}</div>
					</>
				)}
			</div>
		</div>
	);
}

function FromCardBridge() {
	const router = useRouter();
	const searchParams = useSearchParams();
	const vidParam = searchParams.get("vid");
	const wantsFinalPass = searchParams.get("mode") === "final-pass";
	const [status, setStatus] = useState("Preparing editor…");
	const [error, setError] = useState<string | null>(null);
	const startedRef = useRef(false);

	useEffect(() => {
		if (startedRef.current) return;
		startedRef.current = true;

		const run = async () => {
			if (!vidParam) {
				setError("Missing ?vid= parameter.");
				return;
			}
			const vid = vidParam;
			const editor = EditorCore.getInstance();

			// Reopen existing project if we've already created one for this card.
			const existingId =
				typeof window !== "undefined"
					? window.localStorage.getItem(LS_PROJECT_KEY(vid))
					: null;
			if (existingId) {
				let loaded = false;
				try {
					setStatus("Reopening project…");
					await editor.project.loadProject({ id: existingId });
					loaded = true;
					// Backfill reverse mapping for projects created before that field existed.
					window.localStorage.setItem(LS_VID_FOR_PROJECT_KEY(existingId), vid);
				} catch {
					// Stale mapping — fall through to create a new one.
					window.localStorage.removeItem(LS_PROJECT_KEY(vid));
				}
				if (loaded) {
					if (wantsFinalPass) {
						// Failures here shouldn't block opening the editor — land
						// on Final Pass and let the clip picker handle it.
						try {
							const res = await fetch(`/api/videos/${vid}/editor-bootstrap`, {
								credentials: "include",
							});
							const p = res.ok
								? ((await res.json()) as BootstrapPayload)
								: null;
							await sendToFinalPass({
								editor,
								projectId: existingId,
								vid,
								cardVideo: p?.card_video,
								setStatus,
							});
						} catch (e) {
							console.warn("send to final pass failed", e);
							useEditorModeStore.getState().setMode("final-pass");
						}
					}
					router.replace(`/editor/${existingId}`);
					return;
				}
			}

			setStatus("Loading card data…");
			let payload: BootstrapPayload;
			try {
				const res = await fetch(`/api/videos/${vid}/editor-bootstrap`, {
					credentials: "include",
				});
				if (!res.ok) {
					setError(`Bootstrap failed (${res.status}). Is the card published?`);
					return;
				}
				payload = (await res.json()) as BootstrapPayload;
			} catch (e) {
				setError(`Could not reach creatorgrowth: ${(e as Error).message}`);
				return;
			}

			setStatus(`Creating project "${payload.title}"…`);
			let projectId: string;
			try {
				projectId = await editor.project.createNewProject({
					name: payload.title,
				});
			} catch (e) {
				setError(`Could not create project: ${(e as Error).message}`);
				return;
			}

			window.localStorage.setItem(LS_PROJECT_KEY(vid), projectId);
			window.localStorage.setItem(LS_VID_FOR_PROJECT_KEY(projectId), vid);
			if (payload.content_doc?.text) {
				window.localStorage.setItem(
					LS_CONTENT_DOC_KEY(vid),
					payload.content_doc.text,
				);
			}
			if (payload.content_doc?.rel_path) {
				window.localStorage.setItem(
					LS_CONTENT_DOC_PATH_KEY(vid),
					payload.content_doc.rel_path,
				);
			}
			if (payload.bullet_doc?.text) {
				window.localStorage.setItem(
					LS_BULLET_DOC_KEY(vid),
					payload.bullet_doc.text,
				);
			}
			if (payload.bullet_doc?.rel_path) {
				window.localStorage.setItem(
					LS_BULLET_DOC_PATH_KEY(vid),
					payload.bullet_doc.rel_path,
				);
			}

			// Import rendered diagram/chapter MP4s into the project's media bin.
			// Failures don't block the redirect — Andy can still use the editor.
			const assets = payload.assets || [];
			if (assets.length > 0) {
				setStatus(
					`Importing ${assets.length} asset${assets.length === 1 ? "" : "s"}…`,
				);
				const files: File[] = [];
				for (let i = 0; i < assets.length; i++) {
					const a = assets[i];
					setStatus(`Downloading ${a.name} (${i + 1}/${assets.length})…`);
					try {
						const res = await fetch(a.url, { credentials: "include" });
						if (!res.ok) continue;
						const blob = await res.blob();
						const filename = `${a.name.replace(/[^\w.-]+/g, "_")}.mp4`;
						files.push(
							new File([blob], filename, {
								type: blob.type || "video/mp4",
							}),
						);
					} catch (e) {
						console.warn("asset fetch failed", a.url, e);
					}
				}

				if (files.length > 0) {
					try {
						setStatus("Processing assets…");
						const processed = await processMediaAssets({ files });
						for (const asset of processed) {
							await editor.media.addMediaAsset({ projectId, asset });
						}
					} catch (e) {
						console.warn("processMediaAssets failed", e);
					}
				}
			}

			if (wantsFinalPass) {
				try {
					await sendToFinalPass({
						editor,
						projectId,
						vid,
						cardVideo: payload.card_video,
						setStatus,
					});
				} catch (e) {
					console.warn("send to final pass failed", e);
					useEditorModeStore.getState().setMode("final-pass");
				}
			}

			setStatus("Opening editor…");
			router.replace(`/editor/${projectId}`);
		};

		run().catch((e) => {
			setError((e as Error).message || "Unknown error");
		});
	}, [vidParam, wantsFinalPass, router]);

	return <BridgeShell status={status} error={error} />;
}
