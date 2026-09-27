import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import type { AnalysisProvenanceMetadata } from "@/lib/domain/analysis-provenance";
import { DemoFoodVisionProvider } from "@/lib/providers/food-vision/demo";
import {
  extractOpenAIErrorDetails,
  logFoodVisionDiagnostic,
} from "@/lib/providers/food-vision/diagnostics";
import { FoodVisionError } from "@/lib/providers/food-vision/errors";
import { createFoodVisionProvider } from "@/lib/providers/food-vision/factory";
import {
  detectSupportedImageMimeType,
} from "@/lib/providers/food-vision/types";
import { getOpenAIServerConfig } from "@/lib/server/env";
import {
  ANALYZE_RATE_LIMIT,
  clientIpFromHeaders,
  consumeRateLimit,
  rateLimitedJsonResponse,
} from "@/lib/server/rate-limit";
import { elapsedMs, logSafeTiming } from "@/lib/server/timing";
import { authenticated, apiError } from "@/lib/server/auth";
import { acquireLiveAnalysis } from "@/lib/server/live-analysis-admission";
import { reserveDailyLiveAnalysis } from "@/lib/server/durable-analysis-quota";
import {
  readBoundedRequestBody,
  RequestBodyTooLargeError,
  RequestBodyTimeoutError,
} from "@/lib/server/request-body";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_IMAGE_BYTES + 512 * 1024;

const publicErrorStatus: Record<string, number> = {
  invalid_key: 503,
  model_unavailable: 503,
  network_timeout: 504,
  rate_limited: 429,
  service_unavailable: 503,
  invalid_response: 502,
  image_rejected: 422,
  unknown: 500,
};

function errorResponse(code: string, status: number) {
  return NextResponse.json({ error: { code } }, { status });
}

export async function POST(request: Request) {
  let imageMimeType = "unknown";
  let imageByteSize = 0;
  const startedAt = performance.now();
  let visionStartedAt: number | null = null;
  let visionMode: string | undefined;
  let analysisProvenance: AnalysisProvenanceMetadata | null = null;
  const onMetadata = (metadata: AnalysisProvenanceMetadata) => { analysisProvenance = metadata; };

  try {
    const ip = clientIpFromHeaders(request.headers);
    if (!consumeRateLimit(`analyze:${ip}`, ANALYZE_RATE_LIMIT).allowed) {
      const limited = rateLimitedJsonResponse();
      return NextResponse.json(limited.body, {
        status: limited.status,
        headers: limited.headers,
      });
    }

    let formData: FormData;
    try {
      const bytes = await readBoundedRequestBody(request, MAX_MULTIPART_BYTES);
      formData = await new Response(bytes, { headers: request.headers }).formData();
    } catch (error) {
      return error instanceof RequestBodyTooLargeError
        ? errorResponse("file_too_large", 413)
        : error instanceof RequestBodyTimeoutError
          ? errorResponse("network_timeout", 408)
        : errorResponse("invalid_file", 400);
    }
    const forceDemo = formData.get("mode") === "demo";
    const provider = forceDemo
      ? new DemoFoodVisionProvider()
      : createFoodVisionProvider();
    visionMode = provider.mode;

    if (provider.mode === "demo") {
      visionStartedAt = performance.now();
      const analysis = await provider.analyzeImage(
        {
          data: "",
          mimeType: "image/jpeg",
        },
        { signal: request.signal, onMetadata },
      );
      return NextResponse.json({ analysis, analysisProvenance, mode: provider.mode });
    }

    let userId: string;
    let userDb: Awaited<ReturnType<typeof authenticated>>["db"];
    try {
      const { user, db } = await authenticated(request);
      userId = user.id;
      userDb = db;
    } catch (error) {
      return apiError(error);
    }
    if (process.env.KCALCUE_ANALYSIS_ENABLED === "false") {
      return errorResponse("analysis_paused", 503);
    }

    const image = formData.get("image");
    if (!(image instanceof File) || image.size === 0) {
      return errorResponse("missing_image", 400);
    }
    if (image.size > MAX_IMAGE_BYTES) {
      return errorResponse("file_too_large", 413);
    }

    const bytes = Buffer.from(await image.arrayBuffer());
    const detectedMimeType = detectSupportedImageMimeType(bytes);
    if (!detectedMimeType) {
      return errorResponse("invalid_file", 415);
    }

    imageMimeType = detectedMimeType;
    imageByteSize = bytes.byteLength;
    const attemptId = formData.get("attemptId");
    if (attemptId !== null &&
      (typeof attemptId !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(attemptId)))
      return errorResponse("invalid_request", 400);
    const attempt = attemptId === null ? undefined : {
      id: attemptId.toLowerCase(),
      // Salt the fingerprint by verified account so it cannot correlate photos
      // across users; neither the photo nor AI output enters quota storage.
      imageDigest: createHash("sha256").update(userId).update("\0").update(bytes).digest("hex"),
    };
    const release = acquireLiveAnalysis(userId);
    if (!release) {
      const limited = rateLimitedJsonResponse();
      return NextResponse.json(limited.body, {
        status: limited.status,
        headers: limited.headers,
      });
    }

    try {
      let admission;
      try {
        admission = await reserveDailyLiveAnalysis(userDb, userId, undefined, undefined, attempt);
      } catch (error) {
        // If quota storage is unavailable, do not invoke a paid provider.
        console.error("[kcalcue:analysis-quota]", {
          errorClass: error instanceof Error ? error.name : "unknown",
        });
        return errorResponse("service_unavailable", 503);
      }
      if (admission.duplicate)
        return errorResponse(admission.duplicate === "same" ? "analysis_outcome_unknown" : "invalid_request",
          admission.duplicate === "same" ? 409 : 400);
      if (!admission.allowed) {
        const limited = rateLimitedJsonResponse(admission.retryAfterSeconds);
        return NextResponse.json(limited.body, {
          status: limited.status,
          headers: limited.headers,
        });
      }
      visionStartedAt = performance.now();
      const analysis = await provider.analyzeImage(
        {
          data: bytes.toString("base64"),
          mimeType: detectedMimeType,
        },
        { signal: request.signal, onMetadata },
      );
      return NextResponse.json({ analysis, analysisProvenance, mode: provider.mode });
    } finally {
      release();
    }
  } catch (error) {
    if (error instanceof FoodVisionError) {
      if (!error.diagnostic) {
        const details = extractOpenAIErrorDetails(error.cause ?? error);
        logFoodVisionDiagnostic({
          stage: "unknown",
          errorClass: details.errorClass,
          httpStatus: details.httpStatus,
          openaiErrorCode: details.openaiErrorCode,
          safeMessage: details.safeMessage,
          model: getOpenAIServerConfig()?.model ?? "unset",
          imageMimeType,
          imageByteSize,
        });
      }
      return errorResponse(error.code, publicErrorStatus[error.code] ?? 500);
    }

    const details = extractOpenAIErrorDetails(error);
    logFoodVisionDiagnostic({
      stage: "unknown",
      errorClass: details.errorClass,
      httpStatus: details.httpStatus,
      openaiErrorCode: details.openaiErrorCode,
      safeMessage: details.safeMessage,
      model: getOpenAIServerConfig()?.model ?? "unset",
      imageMimeType,
      imageByteSize,
    });
    return errorResponse("unknown", 500);
  } finally {
    if (visionStartedAt !== null && visionMode) {
      logSafeTiming({
        operation: "food-vision",
        mode: visionMode,
        imageMimeType,
        imageByteSize,
        foodVisionMs: elapsedMs(visionStartedAt),
        totalMs: elapsedMs(startedAt),
      });
    }
  }
}
