import { describe, expect, it } from "vitest";

import {
  detectSupportedImageMimeType,
  inferSupportedImageMimeType,
  isHeicFile,
} from "./types";

function ascii(value: string): number[] {
  return [...value].map((character) => character.charCodeAt(0));
}

function ftypBytes(majorBrand: string, compatibleBrands = ["mif1"]): Uint8Array {
  const bytes = new Uint8Array(16 + compatibleBrands.length * 4);
  new DataView(bytes.buffer).setUint32(0, bytes.length, false);
  bytes.set(ascii("ftyp"), 4);
  bytes.set(ascii(majorBrand), 8);
  compatibleBrands.forEach((brand, index) => {
    bytes.set(ascii(brand), 16 + index * 4);
  });
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
    expect(detectSupportedImageMimeType(ftypBytes("heix"))).toBe("image/heic");
    expect(detectSupportedImageMimeType(ftypBytes("mif1"))).toBe("image/heif");
    expect(detectSupportedImageMimeType(ftypBytes("mif1", ["mif1", "miaf"]))).toBe(
      "image/heif",
    );
    expect(
      detectSupportedImageMimeType(ftypBytes("mif1", ["avif", "mif1", "miaf"])),
    ).toBeNull();
    expect(detectSupportedImageMimeType(ftypBytes("avif"))).toBeNull();
    expect(detectSupportedImageMimeType(ftypBytes("avis"))).toBeNull();
    expect(detectSupportedImageMimeType(ftypBytes("avio"))).toBeNull();
    expect(detectSupportedImageMimeType(ftypBytes("miaf"))).toBeNull();
    expect(detectSupportedImageMimeType(ftypBytes("mif1", ["avis"]))).toBeNull();
    expect(detectSupportedImageMimeType(ftypBytes("mif1", ["avio"]))).toBeNull();
    expect(detectSupportedImageMimeType(ftypBytes("isom"))).toBeNull();
    expect(detectSupportedImageMimeType(ftypBytes("hevc"))).toBeNull();
    expect(detectSupportedImageMimeType(ftypBytes("hevx"))).toBeNull();
  });

  it("identifies HEIC-like filenames for the preview fallback copy", () => {
    expect(isHeicFile("meal.heic", "")).toBe(true);
    expect(isHeicFile("meal.heif", "image/jpeg")).toBe(true);
    expect(isHeicFile("meal.jpg", "image/jpeg")).toBe(false);
  });
});
