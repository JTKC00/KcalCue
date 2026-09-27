import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import sharp from "sharp";
import { HttpError } from "@/lib/server/auth";
import { detectSupportedImageMimeType } from "@/lib/providers/food-vision/types";
import {
  MAX_PHOTO_INPUT_BYTES,
  MAX_PHOTO_JPEG_BYTES,
  PHOTO_PIPELINE_VERSION,
} from "@/lib/firebase/photo-assets";

export interface StoredPhoto {
  jpeg: Uint8Array;
  inputSha256: string;
  jpegSha256: string;
  width: number;
  height: number;
  pipelineVersion: typeof PHOTO_PIPELINE_VERSION;
}

// Server-only preparation for a future private upload path. The existing
// draft-preview route remains separate and does not persist its output.
export async function encodeStoredPhoto(input: Uint8Array): Promise<StoredPhoto> {
  if (!input.byteLength) throw new HttpError(400, "invalid_file");
  if (input.byteLength > MAX_PHOTO_INPUT_BYTES)
    throw new HttpError(413, "file_too_large");
  const bytes = Buffer.from(input);
  if (!detectSupportedImageMimeType(bytes))
    throw new HttpError(415, "invalid_file");

  let jpeg: Buffer;
  let width: number;
  let height: number;
  try {
    const output = await sharp(bytes, { limitInputPixels: 40_000_000 })
      .rotate()
      .resize(1600, 1600, { fit: "inside", withoutEnlargement: true })
      .flatten({ background: "#ffffff" })
      .jpeg({ quality: 80 })
      .toBuffer({ resolveWithObject: true });
    jpeg = output.data;
    width = output.info.width;
    height = output.info.height;
  } catch (error) {
    if (error instanceof Error && error.message.includes("Input image exceeds pixel limit"))
      throw new HttpError(413, "image_dimensions_too_large");
    throw new HttpError(422, "image_read_failed");
  }
  if (jpeg.byteLength > MAX_PHOTO_JPEG_BYTES)
    throw new HttpError(413, "photo_output_too_large");
  if (jpeg.byteLength < 3 || width < 1 || width > 1600 || height < 1 || height > 1600)
    throw new HttpError(422, "image_read_failed");

  return {
    jpeg,
    inputSha256: createHash("sha256").update(bytes).digest("hex"),
    jpegSha256: createHash("sha256").update(jpeg).digest("hex"),
    width,
    height,
    pipelineVersion: PHOTO_PIPELINE_VERSION,
  };
}
