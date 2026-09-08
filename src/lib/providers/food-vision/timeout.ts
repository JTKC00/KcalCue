// Gemini 3.7 Flash is a thinking model; a tiny structured response already
// exceeded the previous 15s HTTP timeout in live reproduction.
export const GEMINI_HTTP_TIMEOUT_MS = 90_000;
export const GEMINI_ABORT_TIMEOUT_MS = 100_000;
