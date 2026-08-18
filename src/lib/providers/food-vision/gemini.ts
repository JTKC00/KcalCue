import { ApiError, GoogleGenAI } from "@google/genai";
import {
  foodAnalysisJsonSchema,
  foodAnalysisSchema,
  type FoodAnalysis,
} from "@/lib/domain/food-analysis";
import type { GeminiServerConfig } from "@/lib/server/env";
import {
  base64ByteLength,
  extractGeminiErrorDetails,
  logFoodVisionDiagnostic,
  type FoodVisionDiagnostic,
  type FoodVisionFailureStage,
} from "./diagnostics";
import { FoodVisionError } from "./errors";
import {
  FOOD_VISION_SYSTEM_INSTRUCTION,
  FOOD_VISION_USER_PROMPT,
} from "./prompt";
import type { FoodImageInput, FoodVisionProvider } from "./types";

// Gemini 3.7 Flash is a thinking model; a tiny structured response already
// exceeded the previous 15s HTTP timeout in live reproduction.
export const GEMINI_HTTP_TIMEOUT_MS = 90_000;
export const GEMINI_ABORT_TIMEOUT_MS = 100_000;

function mapGeminiError(error: unknown): FoodVisionError {
  if (error instanceof FoodVisionError) return error;

  if (error instanceof ApiError) {
    const message = error.message.toLowerCase();
    if (error.status === 401 || error.status === 403) {
      return new FoodVisionError("invalid_key", "Gemini authentication failed.", {
        cause: error,
      });
    }
    if (error.status === 404) {
      return new FoodVisionError(
        "model_unavailable",
        "The configured Gemini model is unavailable.",
        { cause: error },
      );
    }
    if (error.status === 429) {
      return new FoodVisionError("rate_limited", "Gemini rate limit reached.", {
        cause: error,
      });
    }
    if (error.status === 504) {
      return new FoodVisionError("network_timeout", "Gemini request timed out.", {
        cause: error,
      });
    }
    if (
      error.status === 400 &&
      /(api[_ -]?key|credential|authentication|unauthenticated)/i.test(message)
    ) {
      return new FoodVisionError("invalid_key", "Gemini authentication failed.", {
        cause: error,
      });
    }
    if (
      error.status === 400 &&
      /(model).*(not found|not supported|unavailable|invalid)|unsupported model/i.test(message)
    ) {
      return new FoodVisionError(
        "model_unavailable",
        "The configured Gemini model is unavailable.",
        { cause: error },
      );
    }
    if (
      error.status === 413 ||
      error.status === 415 ||
      (error.status === 400 &&
        /(image|mime|media|inline.?data|unsupported file|safety)/i.test(message))
    ) {
      return new FoodVisionError("image_rejected", "Gemini rejected the image.", {
        cause: error,
      });
    }
    if (error.status >= 500) {
      return new FoodVisionError(
        "service_unavailable",
        "Gemini is temporarily unavailable.",
        { cause: error },
      );
    }
  }

  if (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return new FoodVisionError("network_timeout", "Gemini request timed out.", {
      cause: error,
    });
  }

  return new FoodVisionError("unknown", "Gemini request failed.", {
    cause: error instanceof Error ? error : undefined,
  });
}

function stripNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, nested]) => nested !== null)
        .map(([key, nested]) => [key, stripNulls(nested)]),
    );
  }
  return value;
}

function diagnosticFor(
  error: unknown,
  stage: FoodVisionFailureStage,
  context: {
    model: string;
    imageMimeType: string;
    imageByteSize: number;
  },
): FoodVisionDiagnostic {
  if (error instanceof FoodVisionError && error.diagnostic) {
    return error.diagnostic;
  }

  const details = extractGeminiErrorDetails(
    error instanceof FoodVisionError ? (error.cause ?? error) : error,
  );

  return {
    stage,
    errorClass: details.errorClass,
    httpStatus: details.httpStatus,
    geminiErrorCode: details.geminiErrorCode,
    safeMessage: details.safeMessage,
    model: context.model,
    imageMimeType: context.imageMimeType,
    imageByteSize: context.imageByteSize,
  };
}

export class GeminiFoodVisionProvider implements FoodVisionProvider {
  readonly id = "gemini";
  readonly mode = "live" as const;
  private readonly client: GoogleGenAI;

  constructor(private readonly config: GeminiServerConfig) {
    this.client = new GoogleGenAI({ apiKey: config.apiKey });
  }

  async analyzeImage(image: FoodImageInput): Promise<FoodAnalysis> {
    const context = {
      model: this.config.model,
      imageMimeType: image.mimeType,
      imageByteSize: base64ByteLength(image.data),
    };
    let stage: FoodVisionFailureStage = "gemini_request";

    try {
      const response = await this.client.models.generateContent({
        model: this.config.model,
        contents: [
          {
            inlineData: {
              mimeType: image.mimeType,
              data: image.data,
            },
          },
          { text: FOOD_VISION_USER_PROMPT },
        ],
        config: {
          systemInstruction: FOOD_VISION_SYSTEM_INSTRUCTION,
          responseMimeType: "application/json",
          responseJsonSchema: foodAnalysisJsonSchema,
          abortSignal: AbortSignal.timeout(GEMINI_ABORT_TIMEOUT_MS),
          httpOptions: {
            timeout: GEMINI_HTTP_TIMEOUT_MS,
            retryOptions: {
              attempts: 2,
              initialDelay: 1.5,
              maxDelay: 6,
            },
          },
        },
      });

      if (!response.text?.trim()) {
        stage = "empty_response";
        throw new FoodVisionError(
          "invalid_response",
          "Gemini returned an empty response.",
        );
      }

      let parsed: unknown;
      try {
        stage = "parse_json";
        parsed = stripNulls(JSON.parse(response.text));
      } catch (error) {
        throw new FoodVisionError(
          "invalid_response",
          "Gemini returned malformed JSON.",
          { cause: error },
        );
      }

      stage = "validate_schema";
      const validated = foodAnalysisSchema.safeParse(parsed);
      if (!validated.success) {
        throw new FoodVisionError(
          "invalid_response",
          "Gemini returned data that failed server validation.",
          { cause: validated.error },
        );
      }

      return validated.data;
    } catch (error) {
      const mapped = mapGeminiError(error);
      const diagnostic = diagnosticFor(error, stage, context);
      logFoodVisionDiagnostic(diagnostic);
      throw new FoodVisionError(mapped.code, mapped.message, {
        cause: mapped.cause ?? (error instanceof Error ? error : undefined),
        diagnostic,
      });
    }
  }
}
