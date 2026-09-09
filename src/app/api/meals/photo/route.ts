import sharp from "sharp";
import { z } from "zod";
import { authenticated, apiError, HttpError } from "@/lib/server/auth";
import { detectSupportedImageMimeType } from "@/lib/providers/food-vision/types";

export const runtime = "nodejs";
export async function POST(request: Request) {
  try {
    await authenticated(request);
    if (Number(request.headers.get("content-length")) > 11 * 1024 * 1024)
      throw new HttpError(413, "file_too_large");
    const data = await request.formData();
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
        .rotate()
        .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch {
      throw new HttpError(422, "image_read_failed");
    }
    return new Response(new Uint8Array(jpeg), {
      headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store" },
    });
  } catch (error) {
    return apiError(error);
  }
}
