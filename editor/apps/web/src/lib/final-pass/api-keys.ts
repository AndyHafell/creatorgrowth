// BYO-key for Final Pass AI. Members paste their OWN ElevenLabs + Gemini keys;
// the keys live only in their browser (localStorage) and are sent per-request as
// headers so the AI routes spend on the member's own quota — never the platform
// key. This is the launch model: a public/free-trial editor on a shared platform
// key would let anyone burn Andy's credits, so the routes require the caller's
// key instead (see the 4 final-pass routes).
//
//   Gemini key  -> required for analyze / chat / chapters (no local fallback)
//   ElevenLabs  -> optional; no key just uses the free in-browser Whisper instead
//                  of cloud Scribe.

export const ELEVEN_KEY_STORAGE = "cg.final-pass.elevenlabs-key";
export const GEMINI_KEY_STORAGE = "cg.final-pass.gemini-key";

// Request headers the routes read the caller's key from.
export const ELEVEN_KEY_HEADER = "x-eleven-key";
export const GEMINI_KEY_HEADER = "x-gemini-key";

// Fired whenever a key is saved/cleared so any open UI can re-render.
export const API_KEYS_CHANGED_EVENT = "cg-final-pass-keys-changed";

type KeyKind = "eleven" | "gemini";

function storageKey(kind: KeyKind): string {
	return kind === "eleven" ? ELEVEN_KEY_STORAGE : GEMINI_KEY_STORAGE;
}

export function getStoredKey(kind: KeyKind): string {
	if (typeof window === "undefined") return "";
	try {
		return (window.localStorage.getItem(storageKey(kind)) ?? "").trim();
	} catch {
		return "";
	}
}

export function setStoredKey(kind: KeyKind, value: string): void {
	if (typeof window === "undefined") return;
	try {
		const trimmed = value.trim();
		if (trimmed) window.localStorage.setItem(storageKey(kind), trimmed);
		else window.localStorage.removeItem(storageKey(kind));
		window.dispatchEvent(new Event(API_KEYS_CHANGED_EVENT));
	} catch {
		/* storage blocked (private mode) — keys just won't persist */
	}
}

// Headers for a Gemini-backed JSON request (analyze / chat / chapters).
export function geminiHeaders(): Record<string, string> {
	const key = getStoredKey("gemini");
	return key ? { [GEMINI_KEY_HEADER]: key } : {};
}

// Header for the ElevenLabs cloud-transcription upload.
export function elevenHeaders(): Record<string, string> {
	const key = getStoredKey("eleven");
	return key ? { [ELEVEN_KEY_HEADER]: key } : {};
}
