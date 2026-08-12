import { NextResponse } from "next/server";
import { DemoFoodVisionProvider } from "@/lib/providers/food-vision/demo";
import { FoodVisionError } from "@/lib/providers/food-vision/errors";
import { createFoodVisionProvider } from "@/lib/providers/food-vision/factory";
import {
  supportedImageMimeTypes,
  type SupportedImageMimeType,
} from "@/lib/providers/food-vision/types";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

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
  try {
    const formData = await request.formData();
    const forceDemo = formData.get("mode") === "demo";
    const provider = forceDemo
      ? new DemoFoodVisionProvider()
      : createFoodVisionProvider();

    if (provider.mode === "demo") {
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
    if (
      !supportedImageMimeTypes.includes(image.type as SupportedImageMimeType)
    ) {
      return errorResponse("invalid_file", 415);
    }

    const bytes = Buffer.from(await image.arrayBuffer());
    const analysis = await provider.analyzeImage({
      data: bytes.toString("base64"),
      mimeType: image.type as SupportedImageMimeType,
    });

    return NextResponse.json({ analysis, mode: provider.mode });
  } catch (error) {
    if (error instanceof FoodVisionError) {
      return errorResponse(error.code, publicErrorStatus[error.code] ?? 500);
    }
    return errorResponse("unknown", 500);
  }
}
