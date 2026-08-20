import { NextResponse } from "next/server";
import { DemoFoodVisionProvider } from "@/lib/providers/food-vision/demo";
import {
  extractGeminiErrorDetails,
  logFoodVisionDiagnostic,
} from "@/lib/providers/food-vision/diagnostics";
import { FoodVisionError } from "@/lib/providers/food-vision/errors";
import { createFoodVisionProvider } from "@/lib/providers/food-vision/factory";
import {
  detectSupportedImageMimeType,
} from "@/lib/providers/food-vision/types";
import { getGeminiServerConfig } from "@/lib/server/env";
import { elapsedMs, logSafeTiming } from "@/lib/server/timing";

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

  try {
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
      return errorResponse("file_too_large", 413);
    }

    const formData = await request.formData();
    const forceDemo = formData.get("mode") === "demo";
    const provider = forceDemo
      ? new DemoFoodVisionProvider()
      : createFoodVisionProvider();
    visionMode = provider.mode;

    if (provider.mode === "demo") {
      visionStartedAt = performance.now();
      const analysis = await provider.analyzeImage({
        data: "",
        mimeType: "image/jpeg",
      });
      return NextResponse.json({ analysis, mode: provider.mode });
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
    visionStartedAt = performance.now();
    const analysis = await provider.analyzeImage({
      data: bytes.toString("base64"),
      mimeType: detectedMimeType,
    });

    return NextResponse.json({ analysis, mode: provider.mode });
  } catch (error) {
    if (error instanceof FoodVisionError) {
      if (!error.diagnostic) {
        const details = extractGeminiErrorDetails(error);
        logFoodVisionDiagnostic({
          stage: "unknown",
          errorClass: details.errorClass,
          httpStatus: details.httpStatus,
          geminiErrorCode: details.geminiErrorCode,
          safeMessage: details.safeMessage,
          model: getGeminiServerConfig()?.model ?? "unset",
          imageMimeType,
          imageByteSize,
        });
      }
      return errorResponse(error.code, publicErrorStatus[error.code] ?? 500);
    }

    const details = extractGeminiErrorDetails(error);
    logFoodVisionDiagnostic({
      stage: "unknown",
      errorClass: details.errorClass,
      httpStatus: details.httpStatus,
      geminiErrorCode: details.geminiErrorCode,
      safeMessage: details.safeMessage,
      model: getGeminiServerConfig()?.model ?? "unset",
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
