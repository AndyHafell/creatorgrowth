import { describe, expect, it } from "bun:test";
import {
	advanceCardStageToReview,
	shouldAdvanceStage,
	uploadRenderToCard,
	type PutToS3,
	type UploadProgress,
} from "../upload-to-card";

type Call = {
	url: string;
	method: string;
	body: unknown;
	credentials?: string;
};

// A fetch stub that records calls and returns canned JSON keyed by URL suffix.
function fetchStub(
	routes: Record<string, { ok?: boolean; status?: number; json: unknown }>,
) {
	const calls: Call[] = [];
	const fn = (async (url: string, init?: RequestInit) => {
		const method = init?.method ?? "GET";
		const body = init?.body ? JSON.parse(init.body as string) : undefined;
		calls.push({
			url,
			method,
			body,
			credentials: init?.credentials as string | undefined,
		});
		const match = Object.keys(routes).find((suffix) => url.endsWith(suffix));
		if (!match) throw new Error(`no route for ${url}`);
		const r = routes[match];
		return {
			ok: r.ok ?? true,
			status: r.status ?? 200,
			json: async () => r.json,
		} as Response;
	}) as unknown as typeof fetch;
	return { fn, calls };
}

const FILE = new Blob(["x".repeat(100)], { type: "video/mp4" });

describe("uploadRenderToCard", () => {
	it("runs presign -> PUT -> finalize and returns the finalize result", async () => {
		const { fn, calls } = fetchStub({
			"/video-presign": {
				json: {
					upload_url: "https://s3.example/put?sig=abc",
					key: "creatorgrowth/videos/u7/42_x.mp4",
					bucket: "my-bucket",
					region: "us-east-1",
				},
			},
			"/video-finalize": {
				json: { ok: true, video_uploaded_at: "2026-06-08T00:00:00Z" },
			},
		});

		const putCalls: Array<{ url: string; contentType: string; file: Blob }> =
			[];
		const putToS3: PutToS3 = async ({ url, file, contentType, onProgress }) => {
			putCalls.push({ url, contentType, file });
			onProgress?.(50);
			onProgress?.(100);
		};

		const progress: UploadProgress[] = [];
		const result = await uploadRenderToCard({
			vid: "42",
			file: FILE,
			filename: "My Video.mp4",
			contentType: "video/mp4",
			onProgress: (p) => progress.push(p),
			fetchFn: fn,
			putToS3,
		});

		// presign request shape
		const presign = calls.find((c) => c.url.endsWith("/video-presign"));
		expect(presign?.url).toBe("/api/videos/42/video-presign");
		expect(presign?.method).toBe("POST");
		expect(presign?.credentials).toBe("include");
		expect(presign?.body).toEqual({
			filename: "My Video.mp4",
			content_type: "video/mp4",
		});

		// PUT went to the presigned URL with the SAME content type (S3 signs it)
		expect(putCalls).toHaveLength(1);
		expect(putCalls[0].url).toBe("https://s3.example/put?sig=abc");
		expect(putCalls[0].contentType).toBe("video/mp4");
		expect(putCalls[0].file).toBe(FILE);

		// finalize request shape
		const finalize = calls.find((c) => c.url.endsWith("/video-finalize"));
		expect(finalize?.url).toBe("/api/videos/42/video-finalize");
		expect(finalize?.credentials).toBe("include");
		expect(finalize?.body).toEqual({
			key: "creatorgrowth/videos/u7/42_x.mp4",
			bucket: "my-bucket",
			region: "us-east-1",
			size: FILE.size,
			filename: "My Video.mp4",
		});

		expect(result.videoUploadedAt).toBe("2026-06-08T00:00:00Z");
		expect(result.key).toBe("creatorgrowth/videos/u7/42_x.mp4");

		// progress reported an uploading phase
		expect(progress.some((p) => p.phase === "uploading")).toBe(true);
	});

	it("throws and skips PUT/finalize when presign returns no upload_url", async () => {
		const { fn, calls } = fetchStub({
			"/video-presign": { json: { error: "No S3 bucket configured" } },
		});
		let putCalled = false;
		const putToS3: PutToS3 = async () => {
			putCalled = true;
		};

		await expect(
			uploadRenderToCard({
				vid: "42",
				file: FILE,
				filename: "v.mp4",
				contentType: "video/mp4",
				fetchFn: fn,
				putToS3,
			}),
		).rejects.toThrow("No S3 bucket configured");

		expect(putCalled).toBe(false);
		expect(calls.some((c) => c.url.endsWith("/video-finalize"))).toBe(false);
	});

	it("propagates a PUT failure and never finalizes", async () => {
		const { fn, calls } = fetchStub({
			"/video-presign": {
				json: {
					upload_url: "https://s3/put",
					key: "k",
					bucket: "b",
					region: "r",
				},
			},
		});
		const putToS3: PutToS3 = async () => {
			throw new Error("S3 PUT 403");
		};

		await expect(
			uploadRenderToCard({
				vid: "42",
				file: FILE,
				filename: "v.mp4",
				contentType: "video/mp4",
				fetchFn: fn,
				putToS3,
			}),
		).rejects.toThrow("S3 PUT 403");

		expect(calls.some((c) => c.url.endsWith("/video-finalize"))).toBe(false);
	});
});

describe("shouldAdvanceStage", () => {
	it("advances from upstream stages", () => {
		expect(shouldAdvanceStage("edited")).toBe(true);
		expect(shouldAdvanceStage("script")).toBe(true);
		expect(shouldAdvanceStage("brief")).toBe(true);
	});
	it("does not regress a card already at/after review", () => {
		expect(shouldAdvanceStage("review")).toBe(false);
		expect(shouldAdvanceStage("published")).toBe(false);
		expect(shouldAdvanceStage("archived")).toBe(false);
	});
});

describe("advanceCardStageToReview", () => {
	it("sets status=review when the card is upstream of review", async () => {
		const { fn, calls } = fetchStub({
			"/api/videos": { json: [{ id: 42, status: "edited" }] },
			"/status": { json: { ok: true, status: "review" } },
		});
		const res = await advanceCardStageToReview({ vid: "42", fetchFn: fn });
		expect(res.advanced).toBe(true);
		const statusCall = calls.find((c) => c.url.endsWith("/status"));
		expect(statusCall?.url).toBe("/api/videos/42/status");
		expect(statusCall?.method).toBe("POST");
		expect(statusCall?.credentials).toBe("include");
		expect(statusCall?.body).toEqual({ status: "review" });
	});

	it("does not POST status when the card is already published", async () => {
		const { fn, calls } = fetchStub({
			"/api/videos": { json: [{ id: 42, status: "published" }] },
		});
		const res = await advanceCardStageToReview({ vid: "42", fetchFn: fn });
		expect(res.advanced).toBe(false);
		expect(calls.some((c) => c.url.endsWith("/status"))).toBe(false);
	});

	it("does nothing when the card is not in the list", async () => {
		const { fn, calls } = fetchStub({
			"/api/videos": { json: [{ id: 7, status: "edited" }] },
		});
		const res = await advanceCardStageToReview({ vid: "42", fetchFn: fn });
		expect(res.advanced).toBe(false);
		expect(calls.some((c) => c.url.endsWith("/status"))).toBe(false);
	});

	it("never throws on a network error (best-effort)", async () => {
		const fn = (async () => {
			throw new Error("network down");
		}) as unknown as typeof fetch;
		const res = await advanceCardStageToReview({ vid: "42", fetchFn: fn });
		expect(res.advanced).toBe(false);
	});
});
