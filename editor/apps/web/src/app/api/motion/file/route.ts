import fs from "node:fs";
import path from "node:path";
import { RENDERS_DIR } from "@/lib/motion/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId") ?? "";
  const name = url.searchParams.get("name") ?? "";

  // Defence-in-depth: only allow MP4s whose filename starts with the jobId.
  if (
    !jobId ||
    !name ||
    !/^[a-f0-9-]{36}$/i.test(jobId) ||
    !name.startsWith(jobId) ||
    !name.endsWith(".mp4") ||
    name.includes("..") ||
    name.includes("/")
  ) {
    return new Response("bad request", { status: 400 });
  }

  const full = path.join(RENDERS_DIR, name);
  if (!fs.existsSync(full)) return new Response("not found", { status: 404 });

  const stat = fs.statSync(full);
  const stream = fs.createReadStream(full);
  // Cast Node stream to a web ReadableStream — Next.js handles either form.
  return new Response(stream as unknown as ReadableStream, {
    headers: {
      "content-type": "video/mp4",
      "content-length": String(stat.size),
      "cache-control": "no-store",
    },
  });
}
