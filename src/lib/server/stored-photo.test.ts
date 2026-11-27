import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { encodeStoredPhoto } from "./stored-photo";
import {
  MAX_PHOTO_INPUT_BYTES,
  MAX_PHOTO_JPEG_BYTES,
  PHOTO_PIPELINE_VERSION,
} from "@/lib/firebase/photo-assets";

describe("private stored-photo preparation", () => {
  it("rotates, bounds and strips metadata from a canonical JPEG", async () => {
    const input = await sharp({
      create: { width: 2000, height: 1000, channels: 3, background: "green" },
    }).withMetadata({ orientation: 6 })
      .withXmp('<x:xmpmeta xmlns:x="adobe:ns:meta/"><note>fixture</note></x:xmpmeta>')
      .jpeg().toBuffer();

    const inputMetadata = await sharp(input).metadata();
    expect(inputMetadata.exif).toBeDefined();
    expect(inputMetadata.icc).toBeDefined();
    expect(inputMetadata.xmp).toBeDefined();

    const result = await encodeStoredPhoto(input);
    const metadata = await sharp(result.jpeg).metadata();
    expect(result).toMatchObject({
      width: 800, height: 1600, pipelineVersion: PHOTO_PIPELINE_VERSION,
      inputSha256: createHash("sha256").update(input).digest("hex"),
      jpegSha256: createHash("sha256").update(result.jpeg).digest("hex"),
    });
    expect(result.jpeg.byteLength).toBeLessThanOrEqual(MAX_PHOTO_JPEG_BYTES);
    expect(metadata.format).toBe("jpeg");
    expect(metadata.exif).toBeUndefined();
    expect(metadata.icc).toBeUndefined();
    expect(metadata.xmp).toBeUndefined();
    expect(metadata.orientation).toBeUndefined();
  });

  it("accepts WebP and emits the same bounded JPEG format", async () => {
    const input = await sharp({
      create: { width: 32, height: 24, channels: 3, background: "blue" },
    }).webp().toBuffer();
    const result = await encodeStoredPhoto(input);
    expect([result.width, result.height]).toEqual([32, 24]);
    expect((await sharp(result.jpeg).metadata()).format).toBe("jpeg");
  });

  it("accepts an image at the exact 10 MiB input boundary", async () => {
    const small = await sharp({
      create: { width: 8, height: 8, channels: 3, background: "green" },
    }).jpeg().toBuffer();
    const input = Buffer.concat([small, Buffer.alloc(MAX_PHOTO_INPUT_BYTES - small.byteLength)]);
    const result = await encodeStoredPhoto(input);
    expect(result.inputSha256).toBe(createHash("sha256").update(input).digest("hex"));
    expect([result.width, result.height]).toEqual([8, 8]);
  });

  it("flattens transparent input on white without enlarging it", async () => {
    const input = await sharp({
      create: { width: 16, height: 16, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    }).png().toBuffer();
    const result = await encodeStoredPhoto(input);
    expect([result.width, result.height]).toEqual([16, 16]);
    const pixel = await sharp(result.jpeg).raw().toBuffer();
    expect([...pixel.subarray(0, 3)]).toEqual([255, 255, 255]);
  });

  it.each([
    [new Uint8Array(), 400, "invalid_file"],
    [new TextEncoder().encode("not an image"), 415, "invalid_file"],
    [new Uint8Array(MAX_PHOTO_INPUT_BYTES + 1), 413, "file_too_large"],
    [new Uint8Array([0xff, 0xd8, 0xff]), 422, "image_read_failed"],
  ])("rejects malformed or oversized input before storage", async (input, status, code) => {
    await expect(encodeStoredPhoto(input)).rejects.toMatchObject({ status, code });
  });

  it("rejects an over-40MP image even when its compressed input is small", async () => {
    const input = await sharp({
      create: { width: 8064, height: 6048, channels: 3, background: "green" },
    }).jpeg({ quality: 70 }).toBuffer();
    expect(input.byteLength).toBeLessThan(MAX_PHOTO_INPUT_BYTES);
    await expect(encodeStoredPhoto(input)).rejects.toMatchObject({
      status: 413, code: "image_dimensions_too_large",
    });
  });
});
