// The before→after cut diff — the structured signal the Part B learning loop
// distills into rules. Compares the AI's ORIGINAL cuts (from the analysis cache)
// against Andy's FINAL keep/cut segments and splits the disagreements into:
//   over-cuts = the AI cut a region Andy KEPT (it was too aggressive there)
//   misses    = Andy cut a region the AI KEPT (it didn't catch it)
// Pure + deterministic so it can be unit-tested without the editor.
//
// Timebases: the AI cuts + transcript are MEDIA seconds; the segments live in
// BUFFER seconds (the waveform timebase). `k = mediaDuration / bufferDuration`
// converts between them, same as the rest of the segment model.

export interface DiffSpan {
	startSec: number;
	endSec: number;
	text: string;
}

export interface CutDiff {
	overCuts: DiffSpan[];
	misses: DiffSpan[];
}

type AiCut = { start: number; end: number };
type Seg = { startSec: number; endSec: number; status: "keep" | "cut" };
type Word = { start: number; end: number; text: string };

/** Transcript text whose words overlap [startSec, endSec] (media), joined. */
function textInRange(
	transcript: Word[],
	startSec: number,
	endSec: number,
): string {
	return transcript
		.filter((t) => t.end > startSec && t.start < endSec)
		.map((t) => t.text.trim())
		.filter(Boolean)
		.join(" ")
		.trim();
}

/** Status of the segment containing `bufSec`; falls back to the last segment. */
function statusAtBuffer(
	segments: Seg[],
	bufSec: number,
): "keep" | "cut" | null {
	for (const s of segments) {
		if (bufSec >= s.startSec && bufSec < s.endSec) return s.status;
	}
	return segments.length ? segments[segments.length - 1].status : null;
}

export function computeCutDiff({
	aiCuts,
	segments,
	k,
	transcript,
}: {
	aiCuts: AiCut[];
	segments: Seg[];
	k: number;
	transcript: Word[];
}): CutDiff {
	const kk = k > 0 ? k : 1;

	// Over-cut: an AI cut whose midpoint now lands in a KEEP segment.
	const overCuts: DiffSpan[] = [];
	for (const c of aiCuts) {
		const midBuf = (c.start + c.end) / 2 / kk;
		if (statusAtBuffer(segments, midBuf) === "keep") {
			overCuts.push({
				startSec: c.start,
				endSec: c.end,
				text: textInRange(transcript, c.start, c.end),
			});
		}
	}

	// Miss: a CUT segment whose media range overlaps no AI cut at all.
	const misses: DiffSpan[] = [];
	for (const s of segments) {
		if (s.status !== "cut") continue;
		const a = s.startSec * kk;
		const b = s.endSec * kk;
		if (!aiCuts.some((c) => c.end > a && c.start < b)) {
			misses.push({
				startSec: a,
				endSec: b,
				text: textInRange(transcript, a, b),
			});
		}
	}

	return { overCuts, misses };
}
