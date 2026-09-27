import OpenAI, {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
  APIUserAbortError,
} from "openai";
import sharp from "sharp";
import { boundedModelName, FOOD_VISION_ANALYSIS_VERSION } from "@/lib/domain/analysis-provenance";
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
  logFoodVisionUsage,
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

const MAX_HEIC_INPUT_PIXELS = 40_000_000;
const MAX_RASTER_PASSTHROUGH_PIXELS = 40_000_000;
const MAX_RASTER_INPUT_PIXELS = 50_000_000;
const MAX_RASTER_EDGE = 10_000;
const PREPARE_TIMEOUT_SECONDS = 15;
const PREPARE_QUEUE_WAIT_MS = 60_000;

// Serializing native decodes bounds per-process peak memory when requests overlap.
let imagePreparationTail: Promise<void> = Promise.resolve();

async function waitForPreparationTurn(
  previous: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new DOMException("Image preparation cancelled.", "AbortError");

  let timer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => rejectWait(new DOMException("Image preparation cancelled.", "AbortError"));
  let rejectWait!: (error: DOMException) => void;
  const interrupted = new Promise<never>((_, reject) => {
    rejectWait = reject;
    timer = setTimeout(
      () => reject(new DOMException("Image preparation queue timed out.", "TimeoutError")),
      PREPARE_QUEUE_WAIT_MS,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([previous, interrupted]);
    if (signal?.aborted) throw new DOMException("Image preparation cancelled.", "AbortError");
  } finally {
    if (timer !== null) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function prepareImageOneAtATime(
  image: FoodImageInput,
  signal?: AbortSignal,
): Promise<OpenAIImageInput> {
  const previous = imagePreparationTail;
  let release!: () => void;
  imagePreparationTail = new Promise<void>((resolve) => { release = resolve; });
  try {
    await waitForPreparationTurn(previous, signal);
    signal?.throwIfAborted();
    return await prepareOpenAIImage(image);
  } finally {
    // An aborted waiter returns at once but keeps its place until the prior
    // native operation completes. Releasing earlier would run decodes together.
    void previous.then(release, release);
  }
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

async function prepareOpenAIImage(image: FoodImageInput): Promise<OpenAIImageInput> {
  const mimeType = image.mimeType;
  try {
    const input = sharp(Buffer.from(image.data, "base64"), {
      limitInputPixels: mimeType === "image/heic" || mimeType === "image/heif"
        ? MAX_HEIC_INPUT_PIXELS
        : MAX_RASTER_INPUT_PIXELS,
    }).timeout({ seconds: PREPARE_TIMEOUT_SECONDS });
    if (mimeType !== "image/heic" && mimeType !== "image/heif") {
      const metadata = await input.metadata();
      const expectedFormat = mimeType === "image/jpeg" ? "jpeg" : mimeType.slice(6);
      if (metadata.format !== expectedFormat) {
        throw new Error("Image format does not match its MIME type");
      }
      if (!metadata.width || !metadata.height ||
        metadata.width > MAX_RASTER_EDGE || metadata.height > MAX_RASTER_EDGE) {
        throw new Error("Image dimensions exceed the supported limit");
      }
      const pixels = metadata.width * metadata.height;
      if (pixels <= MAX_RASTER_PASSTHROUGH_PIXELS) {
        // metadata() alone accepts some truncated files. Decode every pixel
        // before the paid request while retaining normal uploads unchanged.
        await input.stats();
        return { data: image.data, mimeType };
      }

      // Modern phone photos can exceed 40 MP while remaining under 10 MiB.
      // JPEG shrink-on-load limits native memory and AI input size.
      const jpeg = await input
        .rotate()
        .resize(1600, 1600, {
          fit: "inside",
          withoutEnlargement: true,
          fastShrinkOnLoad: true,
        })
        .flatten({ background: "#ffffff" })
        .jpeg({ quality: 85 })
        .toBuffer();
      return { data: jpeg.toString("base64"), mimeType: "image/jpeg" };
    }

    const jpeg = await input
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
      const preparedImage = await prepareImageOneAtATime(image, options?.signal);
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
          maxRetries: 0,
          timeout: OPENAI_HTTP_TIMEOUT_MS,
          signal: AbortSignal.any([
            AbortSignal.timeout(OPENAI_ABORT_TIMEOUT_MS),
            ...(options?.signal ? [options.signal] : []),
          ]),
        },
      );

      // A provider response may incur usage even if its JSON later fails validation.
      if (response.usage) {
        logFoodVisionUsage({
          requestedModel: this.config.model,
          reportedModel: response.model,
          analysisVersion: FOOD_VISION_ANALYSIS_VERSION,
          foodVisionMs: performance.now() - startedAt,
          usage: response.usage,
        });
      }

      if (!response.output_text.trim()) {
        stage = "empty_response";
        throw new FoodVisionError("invalid_response", "OpenAI returned an empty response.");
      }

      let parsed: unknown;
      try {
        stage = "parse_json";
        parsed = stripOptionalNulls(JSON.parse(response.output_text));
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

      options?.onMetadata?.({
        provider: "openai",
        requestedModel: boundedModelName(this.config.model),
        reportedModel: boundedModelName(response.model),
        modelVersion: null,
        analysisVersion: FOOD_VISION_ANALYSIS_VERSION,
        analyzedAt: new Date().toISOString(),
      });
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
