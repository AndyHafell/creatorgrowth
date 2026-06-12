// Upload a finished editor render straight to the user's S3 and attach it to the
// creatorgrowth card the editor was opened from — the same presign → PUT →
// finalize flow the Publish page's drag-drop uses (`pubUploadVideo` in
// creatorgrowth/templates/index.html). After finalize the card's Publish tab
// VIDEO panel renders the player (signed GET via /api/videos/{vid}/video-url).
//
// ROUTING NOTE: these are Flask endpoints at the site ROOT, NOT Next.js routes.
// Call them with bare absolute paths ("/api/videos/...") and credentials:"include"
// so the session cookie rides along. Do NOT prefix with the editor's /editor
// basePath — that would hit the wrong handler.

export type FetchFn = typeof fetch;

export type PutToS3 = (args: {
	url: string;
	file: Blob;
	contentType: string;
	onProgress?: (pct: number) => void;
}) => Promise<void>;

export type UploadProgress =
	| { phase: "presigning" }
	| { phase: "uploading"; pct: number }
	| { phase: "finalizing" };

export interface UploadResult {
	key: string;
	bucket: string;
	region: string;
	size: number;
	filename: string;
	videoUploadedAt: string;
}

// PUT the bytes straight to the presigned S3 URL with upload progress. XHR (not
// fetch) because only XHR exposes upload.onprogress. The Content-Type MUST match
// what presign signed, or S3 rejects the PUT with SignatureDoesNotMatch.
const defaultPutToS3: PutToS3 = ({ url, file, contentType, onProgress }) =>
	new Promise<void>((resolve, reject) => {
		const xhr = new XMLHttpRequest();
		xhr.open("PUT", url, true);
		xhr.setRequestHeader("Content-Type", contentType);
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable) {
				onProgress?.(Math.round((e.loaded / e.total) * 100));
			}
		};
		xhr.onload = () =>
			xhr.status >= 200 && xhr.status < 300
				? resolve()
				: reject(new Error(`S3 PUT failed (${xhr.status})`));
		xhr.onerror = () => reject(new Error("Network error during upload"));
		xhr.send(file);
	});

export async function uploadRenderToCard({
	vid,
	file,
	filename,
	contentType,
	onProgress,
	fetchFn = fetch,
	putToS3 = defaultPutToS3,
}: {
	vid: string;
	file: Blob;
	filename: string;
	contentType: string;
	onProgress?: (p: UploadProgress) => void;
	fetchFn?: FetchFn;
	putToS3?: PutToS3;
}): Promise<UploadResult> {
	// 1) presign against the tenant's S3
	onProgress?.({ phase: "presigning" });
	const preRes = await fetchFn(`/api/videos/${vid}/video-presign`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ filename, content_type: contentType }),
	});
	const pre = (await preRes.json()) as {
		upload_url?: string;
		key?: string;
		bucket?: string;
		region?: string;
		error?: string;
	};
	if (!pre.upload_url) {
		throw new Error(pre.error || "Could not presign the upload.");
	}

	// 2) PUT the bytes directly to S3 (never through Flask/Cloudflare's size cap)
	onProgress?.({ phase: "uploading", pct: 0 });
	await putToS3({
		url: pre.upload_url,
		file,
		contentType,
		onProgress: (pct) => onProgress?.({ phase: "uploading", pct }),
	});

	// 3) finalize — write the key/size onto the card's meta so the Publish panel
	//    (and transcriber/scorer) can find it.
	onProgress?.({ phase: "finalizing" });
	const finRes = await fetchFn(`/api/videos/${vid}/video-finalize`, {
		method: "POST",
		credentials: "include",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			key: pre.key,
			bucket: pre.bucket,
			region: pre.region,
			size: file.size,
			filename,
		}),
	});
	const fin = (await finRes.json()) as {
		ok?: boolean;
		video_uploaded_at?: string;
		error?: string;
	};
	if (!finRes.ok || fin.error) {
		throw new Error(fin.error || "Could not attach the video to the card.");
	}

	return {
		key: pre.key ?? "",
		bucket: pre.bucket ?? "",
		region: pre.region ?? "",
		size: file.size,
		filename,
		videoUploadedAt: fin.video_uploaded_at || new Date().toISOString(),
	};
}

// Pipeline stages that are at or past "Review" — never regress a card here when
// auto-advancing on a fresh render (re-exporting a published card shouldn't bump
// it back to Review). Mirrors creatorgrowth's DEFAULT_TAB_CONFIG ordering.
const AT_OR_AFTER_REVIEW = new Set(["review", "published", "archived"]);

export function shouldAdvanceStage(status: string | undefined | null): boolean {
	if (!status) return true;
	return !AT_OR_AFTER_REVIEW.has(status);
}

// Best-effort: move the card to the "Review" stage after a successful upload so
// it surfaces for review. Reuses the existing /api/videos list (to read the
// card's current status) and /status endpoints — no server change. Never throws;
// a failed advance must not break the (already successful) upload.
export async function advanceCardStageToReview({
	vid,
	fetchFn = fetch,
}: {
	vid: string;
	fetchFn?: FetchFn;
}): Promise<{ advanced: boolean; status?: string }> {
	try {
		const res = await fetchFn("/api/videos", { credentials: "include" });
		if (!res.ok) return { advanced: false };
		const cards = (await res.json()) as Array<{ id: number; status?: string }>;
		const card = cards.find((c) => String(c.id) === vid);
		if (!card || !shouldAdvanceStage(card.status)) {
			return { advanced: false };
		}
		const upd = await fetchFn(`/api/videos/${vid}/status`, {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ status: "review" }),
		});
		if (!upd.ok) return { advanced: false };
		return { advanced: true, status: "review" };
	} catch {
		return { advanced: false };
	}
}
