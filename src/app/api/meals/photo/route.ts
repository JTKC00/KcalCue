import sharp from "sharp";
import { z } from "zod";
import { authenticated, apiError, HttpError } from "@/lib/server/auth";
import { detectSupportedImageMimeType } from "@/lib/providers/food-vision/types";
import {
  readBoundedRequestBody,
  RequestBodyTimeoutError,
  RequestBodyTooLargeError,
} from "@/lib/server/request-body";
import { PHOTO_PREPARATION_RATE_LIMIT } from "@/lib/server/rate-limit";
import { createUserWorkAdmission } from "@/lib/server/live-analysis-admission";

export const runtime = "nodejs";
// Verified UID admission is isolated from the public IP bucket's key eviction.
const acquirePhotoPreparation = createUserWorkAdmission(PHOTO_PREPARATION_RATE_LIMIT);
const MAX_CONCURRENT_PREPARATIONS = 2;
let preparingCount = 0;
export async function POST(request: Request) {
  try {
    const { user } = await authenticated(request);
    if (preparingCount >= MAX_CONCURRENT_PREPARATIONS)
      return Response.json({ error: { code: "rate_limited" } }, {
        status: 429, headers: { "Retry-After": "10", "Cache-Control": "no-store" },
      });
    const release = acquirePhotoPreparation(user.id);
    if (!release)
      return Response.json({ error: { code: "rate_limited" } }, {
        status: 429, headers: { "Retry-After": "10", "Cache-Control": "no-store" },
      });
    preparingCount++;
    try {
      let data: FormData;
      try {
        const bytes = await readBoundedRequestBody(request, 11 * 1024 * 1024);
        data = await new Response(bytes, { headers: request.headers }).formData();
      } catch (error) {
        throw error instanceof RequestBodyTooLargeError
          ? new HttpError(413, "file_too_large")
          : error instanceof RequestBodyTimeoutError
            ? new HttpError(408, "network_timeout")
            : new HttpError(400, "invalid_request");
      }
      const id = z.uuid().safeParse(data.get("mealId"));
      const file = data.get("image");
      if (!id.success || !(file instanceof File) || !file.size)
        throw new HttpError(400, "invalid_request");
      if (file.size > 10 * 1024 * 1024)
        throw new HttpError(413, "file_too_large");
      const bytes = Buffer.from(await file.arrayBuffer());
      if (!detectSupportedImageMimeType(bytes))
        throw new HttpError(415, "invalid_file");
      let jpeg: Buffer;
      try {
        jpeg = await sharp(bytes, { limitInputPixels: 40_000_000 })
          .timeout({ seconds: 15 })
          .rotate()
          .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
          .flatten({ background: "#ffffff" })
          .jpeg({ quality: 80 })
          .toBuffer();
      } catch (error) {
        if (error instanceof Error && error.message.includes("Input image exceeds pixel limit"))
          throw new HttpError(413, "image_dimensions_too_large");
        throw new HttpError(422, "image_read_failed");
      }
      return new Response(new Uint8Array(jpeg), {
        headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
      });
    } finally {
      preparingCount--;
      release();
    }
  } catch (error) {
    return apiError(error);
  }
}
