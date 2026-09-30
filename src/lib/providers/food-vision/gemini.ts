import { ApiError, GoogleGenAI, ThinkingLevel } from "@google/genai";
import { boundedModelName, FOOD_VISION_ANALYSIS_VERSION } from "@/lib/domain/analysis-provenance";
import {
  foodAnalysisJsonSchema,
  foodAnalysisSchema,
  type FoodAnalysis,
} from "@/lib/domain/food-analysis";
import type { GeminiServerConfig } from "@/lib/server/env";
import {
  base64ByteLength,
  extractOpenAIErrorDetails,
  logFoodVisionDiagnostic,
  logFoodVisionUsage,
  type FoodVisionDiagnostic,
  type FoodVisionFailureStage,
} from "./diagnostics";
import { FoodVisionError } from "./errors";
import { prepareImageOneAtATime } from "./image-preparation";
import {
  FOOD_VISION_SYSTEM_INSTRUCTION,
  FOOD_VISION_USER_PROMPT,
} from "./prompt";
import type {
  FoodImageInput,
  FoodVisionAnalyzeOptions,
  FoodVisionProvider,
} from "./types";
import { OPENAI_ABORT_TIMEOUT_MS, OPENAI_HTTP_TIMEOUT_MS } from "./timeout";

export const GEMINI_HTTP_TIMEOUT_MS = OPENAI_HTTP_TIMEOUT_MS;
export const GEMINI_ABORT_TIMEOUT_MS = OPENAI_ABORT_TIMEOUT_MS;
// Medium thinking shares this ceiling with the visible JSON. A small cap can
// stop the response before the schema is finished.
export const GEMINI_MAX_OUTPUT_TOKENS = 32_768;

const GEMINI_SCHEMA_LIMITS = `
Keep every list inside the application schema: at most 12 foods, and at most 12 strings in each list. Short strings are at most 180 characters, display names at most 80, and normalized names at most 100. portionMin and portionMax are both null or both positive numbers no greater than 5000.
`.trim();

function mapGeminiError(error: unknown): FoodVisionError {
  if (error instanceof FoodVisionError) return error;

  if (error instanceof ApiError) {
    const message = error.message.toLowerCase();
    const status = error.status;
    if (status === 401 || status === 403) {
      return new FoodVisionError("invalid_key", "Gemini authentication failed.", { cause: error });
    }
    if (status === 404) {
      return new FoodVisionError("model_unavailable", "The configured Gemini model is unavailable.", { cause: error });
    }
    if (status === 429) {
      return new FoodVisionError("rate_limited", "Gemini rate limit reached.", { cause: error });
    }
    if (status === 408 || status === 504) {
      return new FoodVisionError("network_timeout", "Gemini request timed out.", { cause: error });
    }
    if (
      status === 400 &&
      /(api[_ -]?key|credential|authentication|unauthenticated|permission)/i.test(message)
    ) {
      return new FoodVisionError("invalid_key", "Gemini authentication failed.", { cause: error });
    }
    if (
      status === 400 &&
      /(model).*(not found|not supported|unavailable|invalid|exist)|unknown model/i.test(message)
    ) {
      return new FoodVisionError("model_unavailable", "The configured Gemini model is unavailable.", { cause: error });
    }
    if (
      status === 413 ||
      status === 415 ||
      status === 422 ||
      (status === 400 && /(image|mime|media|inline.?data|unsupported file|content type|file format)/i.test(message))
    ) {
      return new FoodVisionError("image_rejected", "Gemini rejected the image.", { cause: error });
    }
    if (typeof status === "number" && status >= 500) {
      return new FoodVisionError("service_unavailable", "Gemini is temporarily unavailable.", { cause: error });
    }
  }

  if (
    error instanceof DOMException &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  ) {
    return new FoodVisionError("network_timeout", "Gemini request timed out.", { cause: error });
  }

  return new FoodVisionError("unknown", "Gemini request failed.", {
    cause: error instanceof Error ? error : undefined,
  });
}

function stripOptionalNulls(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripOptionalNulls);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, nested]) => nested !== null || key === "portionMin" || key === "portionMax")
        .map(([key, nested]) => [key, stripOptionalNulls(nested)]),
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
    foodVisionMs: number;
  },
): FoodVisionDiagnostic {
  if (error instanceof FoodVisionError && error.diagnostic) return error.diagnostic;
  const details = extractOpenAIErrorDetails(
    error instanceof FoodVisionError ? (error.cause ?? error) : error,
  );
  return {
    stage,
    errorClass: details.errorClass,
    httpStatus: details.httpStatus,
    openaiErrorCode: null,
    providerErrorCode: details.openaiErrorCode,
    safeMessage: details.safeMessage,
    model: context.model,
    imageMimeType: context.imageMimeType,
    imageByteSize: context.imageByteSize,
    foodVisionMs: context.foodVisionMs,
  };
}

export class GeminiFoodVisionProvider implements FoodVisionProvider {
  readonly id = "gemini";
  readonly mode = "live" as const;
  private readonly client: GoogleGenAI;

  constructor(private readonly config: GeminiServerConfig) {
    this.client = new GoogleGenAI({
      apiKey: config.apiKey,
      httpOptions: { timeout: GEMINI_HTTP_TIMEOUT_MS, retryOptions: { attempts: 1 } },
    });
  }

  async analyzeImage(
    image: FoodImageInput,
    options?: FoodVisionAnalyzeOptions,
  ): Promise<FoodAnalysis> {
    const startedAt = performance.now();
    const context = {
      model: this.config.model,
      imageMimeType: image.mimeType,
      imageByteSize: base64ByteLength(image.data),
      foodVisionMs: 0,
    };
    let stage: FoodVisionFailureStage = "image_prepare";

    try {
      options?.signal?.throwIfAborted();
      const preparedImage = await prepareImageOneAtATime(image, options?.signal);
      options?.signal?.throwIfAborted();
      stage = "gemini_request";
      const response = await this.client.models.generateContent({
        model: this.config.model,
        contents: [
          { text: FOOD_VISION_USER_PROMPT },
          { inlineData: { mimeType: preparedImage.mimeType, data: preparedImage.data } },
        ],
        config: {
          systemInstruction: `${FOOD_VISION_SYSTEM_INSTRUCTION}\n\n${GEMINI_SCHEMA_LIMITS}`,
          responseMimeType: "application/json",
          responseJsonSchema: foodAnalysisJsonSchema,
          maxOutputTokens: GEMINI_MAX_OUTPUT_TOKENS,
          thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
          abortSignal: AbortSignal.any([
            AbortSignal.timeout(GEMINI_ABORT_TIMEOUT_MS),
            ...(options?.signal ? [options.signal] : []),
          ]),
          httpOptions: { timeout: GEMINI_HTTP_TIMEOUT_MS, retryOptions: { attempts: 1 } },
        },
      });

      const text = response.text ?? "";
      // Candidate tokens are the visible JSON. Thought tokens stay inside the
      // provider total and are not relabelled as OpenAI-equivalent output.
      if (response.usageMetadata) {
        try {
          logFoodVisionUsage({
            requestedModel: this.config.model,
            reportedModel: response.modelVersion,
            analysisVersion: FOOD_VISION_ANALYSIS_VERSION,
            foodVisionMs: performance.now() - startedAt,
            usage: {
              input_tokens: response.usageMetadata.promptTokenCount,
              output_tokens: response.usageMetadata.candidatesTokenCount,
              total_tokens: response.usageMetadata.totalTokenCount,
            },
          });
        } catch {
          // A telemetry failure must not discard a paid analysis or trigger another call.
        }
      }

      if (!text.trim()) {
        stage = "empty_response";
        throw new FoodVisionError("invalid_response", "Gemini returned an empty response.");
      }

      let parsed: unknown;
      try {
        stage = "parse_json";
        parsed = stripOptionalNulls(JSON.parse(text));
      } catch (error) {
        throw new FoodVisionError("invalid_response", "Gemini returned malformed JSON.", { cause: error });
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

      options?.onMetadata?.({
        provider: "gemini",
        requestedModel: boundedModelName(this.config.model),
        reportedModel: boundedModelName(response.modelVersion),
        modelVersion: null,
        analysisVersion: FOOD_VISION_ANALYSIS_VERSION,
        analyzedAt: new Date().toISOString(),
      });
      return validated.data;
    } catch (error) {
      const mapped = mapGeminiError(error);
      context.foodVisionMs = Math.max(0, Math.round(performance.now() - startedAt));
      const diagnostic = diagnosticFor(error, stage, context);
      try {
        logFoodVisionDiagnostic(diagnostic);
      } catch {
        // Logging stays outside the analysis result.
      }
      throw new FoodVisionError(mapped.code, mapped.message, {
        cause: mapped.cause ?? (error instanceof Error ? error : undefined),
        diagnostic,
      });
    }
  }
}
