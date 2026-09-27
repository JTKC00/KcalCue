export type FoodVisionFailureStage =
  | "openai_request"
  | "image_prepare"
  | "empty_response"
  | "parse_json"
  | "validate_schema"
  | "unknown";

export interface FoodVisionDiagnostic {
  stage: FoodVisionFailureStage;
  errorClass: string;
  httpStatus: number | null;
  openaiErrorCode: string | null;
  safeMessage: string;
  model: string;
  imageMimeType: string;
  imageByteSize: number;
  foodVisionMs?: number;
}

export interface FoodVisionUsage {
  requestedModel: unknown;
  reportedModel: unknown;
  analysisVersion: string;
  foodVisionMs: number;
  usage: {
    input_tokens?: unknown;
    output_tokens?: unknown;
    total_tokens?: unknown;
    input_tokens_details?: { cached_tokens?: unknown } | null;
  };
}

const REDACTED = "[redacted]";

export function sanitizeDiagnosticMessage(message: string): string {
  return message
    .replace(/sk-[0-9A-Za-z_-]{8,}/g, REDACTED)
    .replace(/AIza[0-9A-Za-z_-]{8,}/g, REDACTED)
    .replace(/Bearer\s+\S+/gi, `Bearer ${REDACTED}`)
    .replace(/[A-Z0-9_]+_API_KEY\s*=\s*\S+/gi, `API_KEY=${REDACTED}`)
    .replace(/[A-Za-z0-9+/]{80,}={0,2}/g, REDACTED)
    .slice(0, 500);
}

export function base64ByteLength(data: string): number {
  const trimmed = data.replace(/\s+/g, "");
  if (!trimmed) return 0;
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

export function extractOpenAIErrorDetails(error: unknown): {
  errorClass: string;
  httpStatus: number | null;
  openaiErrorCode: string | null;
  safeMessage: string;
} {
  if (!(error instanceof Error)) {
    return {
      errorClass: typeof error,
      httpStatus: null,
      openaiErrorCode: null,
      safeMessage: sanitizeDiagnosticMessage(String(error)),
    };
  }

  const httpStatus =
    "status" in error && typeof error.status === "number" ? error.status : null;

  let openaiErrorCode: string | null = null;
  let rawMessage = error.message;

  if ("code" in error && typeof error.code === "string") {
    openaiErrorCode = error.code;
  } else if ("type" in error && typeof error.type === "string") {
    openaiErrorCode = error.type;
  }

  if ("error" in error && error.error && typeof error.error === "object") {
    const nested = error.error as {
      message?: unknown;
      code?: unknown;
      type?: unknown;
    };
    if (typeof nested.message === "string") rawMessage = nested.message;
    if (typeof nested.code === "string") {
      openaiErrorCode = nested.code;
    } else if (typeof nested.type === "string") {
      openaiErrorCode = nested.type;
    }
  }

  try {
    const parsed = JSON.parse(error.message) as {
      error?: { message?: unknown; code?: unknown; type?: unknown };
    };
    if (typeof parsed.error?.message === "string") {
      rawMessage = parsed.error.message;
    }
    if (typeof parsed.error?.code === "string") {
      openaiErrorCode = parsed.error.code;
    } else if (typeof parsed.error?.type === "string") {
      openaiErrorCode = parsed.error.type;
    }
  } catch {
    // The SDK sometimes wraps the JSON payload, sometimes returns a plain string.
  }

  return {
    errorClass: error.name || error.constructor.name,
    httpStatus,
    openaiErrorCode,
    safeMessage: sanitizeDiagnosticMessage(rawMessage),
  };
}

export function logFoodVisionDiagnostic(diagnostic: FoodVisionDiagnostic): void {
  const safeFields: Record<string, string | number | null> = {
    stage: diagnostic.stage,
    errorClass: diagnostic.errorClass,
    httpStatus: diagnostic.httpStatus,
    openaiErrorCode: diagnostic.openaiErrorCode,
    safeMessage: diagnostic.safeMessage,
    model: diagnostic.model,
    imageMimeType: diagnostic.imageMimeType,
    imageByteSize: diagnostic.imageByteSize,
  };
  if (diagnostic.foodVisionMs !== undefined) {
    safeFields.foodVisionMs = diagnostic.foodVisionMs;
  }
  console.error("[kcalcue:food-vision]", safeFields);
}

function safeUsageModel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // Log only known public families, not arbitrary provider/config strings or
  // fine-tuned model IDs that may contain private account identifiers.
  const match = /^(gpt-(?:5\.6-(?:luna|terra|sol)|6-(?:luna|sol|astra)))(?:-\d{4}-\d{2}-\d{2})?$/.exec(value);
  return match?.[1] ?? null;
}

function safeTokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value : null;
}

/** Provider billing observability only; never log an image, food or user identifier. */
export function logFoodVisionUsage(event: FoodVisionUsage): void {
  try {
    console.info("[kcalcue:food-vision-usage]", {
      stage: "provider_response",
      requestedModel: safeUsageModel(event.requestedModel),
      reportedModel: safeUsageModel(event.reportedModel),
      analysisVersion: event.analysisVersion,
      inputTokens: safeTokenCount(event.usage.input_tokens),
      cachedInputTokens: safeTokenCount(event.usage.input_tokens_details?.cached_tokens),
      outputTokens: safeTokenCount(event.usage.output_tokens),
      totalTokens: safeTokenCount(event.usage.total_tokens),
      foodVisionMs: Number.isFinite(event.foodVisionMs)
        ? Math.max(0, Math.round(event.foodVisionMs)) : null,
    });
  } catch {
    // Telemetry must never turn a paid, successful analysis into a retry.
  }
}
