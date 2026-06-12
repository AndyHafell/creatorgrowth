import type { TranscriptionSegment } from "@/lib/transcription/types";

export interface DoubleTakeSuggestion {
	id: string;
	startSec: number;
	endSec: number;
	text: string;
	matchedStartSec: number;
	matchedEndSec: number;
	matchedText: string;
	similarity: number;
}

export interface DetectDoubleTakesParams {
	/** Word n-gram size for Jaccard. 3 catches verbatim retakes well. */
	ngram?: number;
	/** Look at this many subsequent segments to find a clean retake. */
	lookahead?: number;
	/** Jaccard similarity ≥ this → flag the earlier segment. 0..1. */
	threshold?: number;
	/** Skip segments shorter than this many normalized words. */
	minWords?: number;
}

const DEFAULTS: Required<DetectDoubleTakesParams> = {
	ngram: 3,
	lookahead: 3,
	threshold: 0.55,
	minWords: 3,
};

/**
 * Find segments where Andy said roughly the same thing again later — the
 * earlier take is a probable flubbed retake and gets flagged blue. We
 * default to KEEPING THE LAST take (the clean one).
 *
 * Heuristic: for each segment, compare to the next `lookahead` segments
 * via word-n-gram Jaccard. If any one scores above threshold, mark this
 * segment as a suggested cut.
 */
export function detectDoubleTakes({
	segments,
	params,
}: {
	segments: TranscriptionSegment[];
	params?: DetectDoubleTakesParams;
}): DoubleTakeSuggestion[] {
	const { ngram, lookahead, threshold, minWords } = { ...DEFAULTS, ...params };

	const normalized = segments.map((s) => normalizeWords(s.text));
	const grams = normalized.map((words) =>
		words.length >= ngram ? ngrams(words, ngram) : new Set(words),
	);

	const suggestions: DoubleTakeSuggestion[] = [];
	const flagged = new Set<number>();

	for (let i = 0; i < segments.length; i++) {
		if (flagged.has(i)) continue;
		if (normalized[i].length < minWords) continue;

		let bestJ = -1;
		let bestScore = 0;
		const end = Math.min(segments.length, i + 1 + lookahead);
		for (let j = i + 1; j < end; j++) {
			if (normalized[j].length < minWords) continue;
			const score = jaccard(grams[i], grams[j]);
			if (score > bestScore) {
				bestScore = score;
				bestJ = j;
			}
		}

		if (bestJ >= 0 && bestScore >= threshold) {
			suggestions.push({
				id: `dt-${segments[i].start.toFixed(2)}-${i}`,
				startSec: segments[i].start,
				endSec: segments[i].end,
				text: segments[i].text.trim(),
				matchedStartSec: segments[bestJ].start,
				matchedEndSec: segments[bestJ].end,
				matchedText: segments[bestJ].text.trim(),
				similarity: bestScore,
			});
			// Don't double-count: the earlier segment is cut, the matched
			// segment is the clean take we keep.
			flagged.add(i);
		}
	}

	return suggestions;
}

function normalizeWords(text: string): string[] {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s']/gu, " ")
		.split(/\s+/)
		.filter(Boolean);
}

function ngrams(words: string[], n: number): Set<string> {
	const out = new Set<string>();
	for (let i = 0; i + n <= words.length; i++) {
		out.add(words.slice(i, i + n).join(" "));
	}
	return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let inter = 0;
	for (const x of a) if (b.has(x)) inter++;
	const union = a.size + b.size - inter;
	return union === 0 ? 0 : inter / union;
}
