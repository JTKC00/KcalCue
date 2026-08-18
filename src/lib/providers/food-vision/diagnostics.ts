export type FoodVisionFailureStage =
  | "gemini_request"
  | "empty_response"
  | "parse_json"
  | "validate_schema"
  | "unknown";

export interface FoodVisionDiagnostic {
  stage: FoodVisionFailureStage;
  errorClass: string;
  httpStatus: number | null;
  geminiErrorCode: string | null;
  safeMessage: string;
  model: string;
  imageMimeType: string;
  imageByteSize: number;
}

const REDACTED = "[redacted]";

export function sanitizeDiagnosticMessage(message: string): string {
  return message
    .replace(/AIza[0-9A-Za-z_-]{8,}/g, REDACTED)
    .replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`)
    .replace(/GEMINI_API_KEY\s*=\s*\S+/gi, `GEMINI_API_KEY=${REDACTED}`)
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, REDACTED)
    .slice(0, 500);
}

export function base64ByteLength(data: string): number {
  const trimmed = data.replace(/\s+/g, "");
  if (!trimmed) return 0;
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

export function extractGeminiErrorDetails(error: unknown): {
  errorClass: string;
  httpStatus: number | null;
  geminiErrorCode: string | null;
  safeMessage: string;
} {
  if (!(error instanceof Error)) {
    return {
      errorClass: typeof error,
      httpStatus: null,
      geminiErrorCode: null,
      safeMessage: sanitizeDiagnosticMessage(String(error)),
    };
  }

  const httpStatus =
    "status" in error && typeof error.status === "number" ? error.status : null;

  let geminiErrorCode: string | null = null;
  let rawMessage = error.message;

  try {
    const parsed = JSON.parse(error.message) as {
      error?: { message?: unknown; status?: unknown; code?: unknown };
    };
    if (typeof parsed.error?.message === "string") {
      rawMessage = parsed.error.message;
    }
    if (typeof parsed.error?.status === "string") {
      geminiErrorCode = parsed.error.status;
    }
  } catch {
    // The SDK sometimes wraps the JSON payload, sometimes returns a plain string.
  }

  return {
    errorClass: error.name || error.constructor.name,
    httpStatus,
    geminiErrorCode,
    safeMessage: sanitizeDiagnosticMessage(rawMessage),
  };
}

export function logFoodVisionDiagnostic(diagnostic: FoodVisionDiagnostic): void {
  console.error("[kcalcue:food-vision]", {
    stage: diagnostic.stage,
    errorClass: diagnostic.errorClass,
    httpStatus: diagnostic.httpStatus,
    geminiErrorCode: diagnostic.geminiErrorCode,
    safeMessage: diagnostic.safeMessage,
    model: diagnostic.model,
    imageMimeType: diagnostic.imageMimeType,
    imageByteSize: diagnostic.imageByteSize,
  });
}
