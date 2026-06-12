import { NextResponse } from "next/server";
import { readStatus } from "@/lib/motion/pipeline";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const jobId = url.searchParams.get("jobId");
  if (!jobId) {
    return NextResponse.json({ error: "jobId required" }, { status: 400 });
  }
  const s = readStatus(jobId);
  if (!s) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json(s);
}
