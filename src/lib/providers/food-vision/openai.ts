import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import sharp from "sharp";
import {
  foodAnalysisJsonSchema,
  foodAnalysisSchema,
  type FoodAnalysis,
} from "@/lib/domain/food-analysis";
import type { OpenAIServerConfig } from "@/lib/server/env";
import {
  base64ByteLength,
  extractOpenAIErrorDetails,
  logFoodVisionDiagnostic,
  type FoodVisionDiagnostic,
  type FoodVisionFailureStage,
} from "./diagnostics";
import { FoodVisionError } from "./errors";
import {
  FOOD_VISION_SYSTEM_INSTRUCTION,
  FOOD_VISION_USER_PROMPT,
} from "./prompt";
import type {
  FoodImageInput,
  FoodVisionAnalyzeOptions,
  FoodVisionProvider,
  SupportedImageMimeType,
} from "./types";

import { OPENAI_HTTP_TIMEOUT_MS, OPENAI_ABORT_TIMEOUT_MS } from "./timeout";
export { OPENAI_HTTP_TIMEOUT_MS, OPENAI_ABORT_TIMEOUT_MS } from "./timeout";

type OpenAIImageMimeType = Exclude<
  SupportedImageMimeType,
  "image/heic" | "image/heif"
>;

interface OpenAIImageInput {
  data: string;
  mimeType: OpenAIImageMimeType;
}

function mapOpenAIError(error: unknown): FoodVisionError {
  if (error instanceof FoodVisionError) return error;

  if (
    error instanceof APIConnectionTimeoutError ||
    error instanceof APIUserAbortError ||
    (error instanceof DOMException &&
      (error.name === "TimeoutError" || error.name === "AbortError"))
  ) {
    return new FoodVisionError("network_timeout", "OpenAI request timed out.", {
      cause: error,
    });
  }

  if (error instanceof APIError) {
    const message = error.message.toLowerCase();
    const status = error.status;

    if (status === 401 || status === 403) {
      return new FoodVisionError("invalid_key", "OpenAI authentication failed.", {
        cause: error,
      });
    }
    if (status === 404) {
      return new FoodVisionError(
        "model_unavailable",
        "The configured OpenAI model is unavailable.",
        { cause: error },
      );
    }
    if (status === 429) {
      return new FoodVisionError("rate_limited", "OpenAI rate limit reached.", {
        cause: error,
      });
    }
    if (status === 408 || status === 504) {
      return new FoodVisionError("network_timeout", "OpenAI request timed out.", {
        cause: error,
      });
    }
    if (status === 413 || status === 415 || status === 422) {
      return new FoodVisionError("image_rejected", "OpenAI rejected the image.", {
        cause: error,
      });
    }
    if (
      status === 400 &&
      /(api[_ -]?key|credential|authentication|unauthorized|permission)/i.test(
        message,
      )
    ) {
      return new FoodVisionError("invalid_key", "OpenAI authentication failed.", {
        cause: error,
      });
    }
    if (
      status === 400 &&
      /(model).*(not found|not supported|unavailable|invalid|exist)|unknown model/i.test(
        message,
      )
    ) {
      return new FoodVisionError(
        "model_unavailable",
        "The configured OpenAI model is unavailable.",
        { cause: error },
      );
    }
    if (
      status === 400 &&
      /(image|image_url|mime|media|unsupported file|content type|file format)/i.test(
        message,
      )
    ) {
      return new FoodVisionError("image_rejected", "OpenAI rejected the image.", {
        cause: error,
      });
    }
    if (typeof status === "number" && status >= 500) {
      return new FoodVisionError(
        "service_unavailable",
        "OpenAI is temporarily unavailable.",
        { cause: error },
      );
    }
  }

  if (error instanceof APIConnectionError) {
    return new FoodVisionError(
      "service_unavailable",
      "OpenAI is temporarily unavailable.",
      { cause: error },
    );
  }

  return new FoodVisionError("unknown", "OpenAI request failed.", {
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

async function prepareOpenAIImage(image: FoodImageInput): Promise<OpenAIImageInput> {
  const mimeType = image.mimeType;
  if (mimeType !== "image/heic" && mimeType !== "image/heif") {
    return { data: image.data, mimeType };
  }

  try {
    const jpeg = await sharp(Buffer.from(image.data, "base64"))
      .rotate()
      .jpeg()
      .toBuffer();
    return { data: jpeg.toString("base64"), mimeType: "image/jpeg" };
  } catch (error) {
    throw new FoodVisionError(
      "image_rejected",
      "OpenAI could not decode the image.",
      { cause: error },
    );
  }
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
  if (error instanceof FoodVisionError && error.diagnostic) {
    return error.diagnostic;
  }

  const details = extractOpenAIErrorDetails(
    error instanceof FoodVisionError ? (error.cause ?? error) : error,
  );

  return {
    stage,
    errorClass: details.errorClass,
    httpStatus: details.httpStatus,
    openaiErrorCode: details.openaiErrorCode,
    safeMessage: details.safeMessage,
    model: context.model,
    imageMimeType: context.imageMimeType,
    imageByteSize: context.imageByteSize,
    foodVisionMs: context.foodVisionMs,
  };
}

export class OpenAIFoodVisionProvider implements FoodVisionProvider {
  readonly id = "openai";
  readonly mode = "live" as const;
  private readonly client: OpenAI;

  constructor(private readonly config: OpenAIServerConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey });
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
      const preparedImage = await prepareOpenAIImage(image);
      options?.signal?.throwIfAborted();
      stage = "openai_request";
      const response = await this.client.responses.create(
        {
          model: this.config.model,
          instructions: FOOD_VISION_SYSTEM_INSTRUCTION,
          input: [
            {
              role: "user",
              content: [
                { type: "input_text", text: FOOD_VISION_USER_PROMPT },
                {
                  type: "input_image",
                  image_url: `data:${preparedImage.mimeType};base64,${preparedImage.data}`,
                  detail: "auto",
                },
              ],
            },
          ],
          text: {
            format: {
              type: "json_schema",
              name: "food_analysis",
              strict: true,
              schema: foodAnalysisJsonSchema,
            },
          },
          max_output_tokens: 4_000,
          store: false,
        },
        {
          maxRetries: 2,
          timeout: OPENAI_HTTP_TIMEOUT_MS,
          signal: AbortSignal.any([
            AbortSignal.timeout(OPENAI_ABORT_TIMEOUT_MS),
            ...(options?.signal ? [options.signal] : []),
          ]),
        },
      );

      if (!response.output_text.trim()) {
        stage = "empty_response";
        throw new FoodVisionError("invalid_response", "OpenAI returned an empty response.");
      }

      let parsed: unknown;
      try {
        stage = "parse_json";
        parsed = stripNulls(JSON.parse(response.output_text));
      } catch (error) {
        throw new FoodVisionError(
          "invalid_response",
          "OpenAI returned malformed JSON.",
          { cause: error },
        );
      }

      stage = "validate_schema";
      const validated = foodAnalysisSchema.safeParse(parsed);
      if (!validated.success) {
        throw new FoodVisionError(
          "invalid_response",
          "OpenAI returned data that failed server validation.",
          { cause: validated.error },
        );
      }

      return validated.data;
    } catch (error) {
      const mapped = mapOpenAIError(error);
      context.foodVisionMs = Math.max(
        0,
        Math.round(performance.now() - startedAt),
      );
      const diagnostic = diagnosticFor(error, stage, context);
      logFoodVisionDiagnostic(diagnostic);
      throw new FoodVisionError(mapped.code, mapped.message, {
        cause: mapped.cause ?? (error instanceof Error ? error : undefined),
        diagnostic,
      });
    }
  }
}
