import { describe, expect, it } from "vitest";

import {
  detectSupportedImageMimeType,
  inferSupportedImageMimeType,
  isHeicFile,
} from "./types";

function ascii(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function ftypBytes(brand: string): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0, 0, 0, 24], 0);
  bytes.set(ascii("ftyp"), 4);
  bytes.set(ascii(brand), 8);
  bytes.set(ascii("mif1"), 16);
  return bytes;
}

describe("supported image MIME handling", () => {
  it("falls back to a supported extension when the browser MIME is blank", () => {
    expect(inferSupportedImageMimeType("meal.HEIF", "")).toBe("image/heif");
    expect(inferSupportedImageMimeType("meal.jpg", "application/octet-stream")).toBe(
      "image/jpeg",
    );
  });

  it("detects the actual image container from its header", () => {
    expect(detectSupportedImageMimeType(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(
      "image/jpeg",
    );
    expect(
      detectSupportedImageMimeType(
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      ),
    ).toBe("image/png");
    const webp = new Uint8Array(12);
    webp.set(ascii("RIFF"), 0);
    webp.set(ascii("WEBP"), 8);
    expect(detectSupportedImageMimeType(webp)).toBe("image/webp");
    expect(detectSupportedImageMimeType(ftypBytes("heic"))).toBe("image/heic");
    expect(detectSupportedImageMimeType(ftypBytes("mif1"))).toBe("image/heif");
  });

  it("identifies HEIC-like filenames for the preview fallback copy", () => {
    expect(isHeicFile("meal.heic", "")).toBe(true);
    expect(isHeicFile("meal.heif", "image/jpeg")).toBe(true);
    expect(isHeicFile("meal.jpg", "image/jpeg")).toBe(false);
  });
});
