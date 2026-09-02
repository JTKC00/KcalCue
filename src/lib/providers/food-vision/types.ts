import type { FoodAnalysis } from "@/lib/domain/food-analysis";

export const supportedImageMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
] as const;

export type SupportedImageMimeType = (typeof supportedImageMimeTypes)[number];

const extensionMimeTypes: Record<string, SupportedImageMimeType> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

const heicBrands = new Set(["heic", "heix"]);
const heifBrands = new Set(["mif1", "msf1", "heif"]);
const avifBrands = new Set(["avif", "avis", "miaf"]);

function ascii(bytes: Uint8Array, start: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(start, start + length));
}

function isoBmffBrands(bytes: Uint8Array): string[] {
  if (bytes.length < 16 || ascii(bytes, 4, 4) !== "ftyp") return [];

  const declaredBoxSize = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0, false);
  const boxEnd = Math.min(
    bytes.length,
    declaredBoxSize >= 16 ? declaredBoxSize : bytes.length,
  );
  const brands: string[] = [ascii(bytes, 8, 4)];
  for (let offset = 16; offset + 4 <= boxEnd; offset += 4) {
    brands.push(ascii(bytes, offset, 4));
  }
  return brands;
}

/** Resolve an empty or generic browser MIME type via the selected filename. */
export function inferSupportedImageMimeType(
  fileName: string,
  reportedMimeType = "",
): SupportedImageMimeType | null {
  const reported = reportedMimeType.split(";", 1)[0]?.trim().toLowerCase();
  if (reported === "image/jpg") return "image/jpeg";
  if (supportedImageMimeTypes.includes(reported as SupportedImageMimeType)) {
    return reported as SupportedImageMimeType;
  }

  const extension = fileName.trim().toLowerCase().match(/\.[^.]+$/)?.[0];
  return extension ? extensionMimeTypes[extension] ?? null : null;
}

/** Detect the actual supported container instead of trusting a client MIME. */
export function detectSupportedImageMimeType(
  bytes: Uint8Array,
): SupportedImageMimeType | null {
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  ) {
    return "image/jpeg";
  }

  if (bytes.length >= 8 && ascii(bytes, 0, 8) === "\x89PNG\r\n\x1a\n") {
    return "image/png";
  }

  if (
    bytes.length >= 12 &&
    ascii(bytes, 0, 4) === "RIFF" &&
    ascii(bytes, 8, 4) === "WEBP"
  ) {
    return "image/webp";
  }

  const majorBrand = isoBmffBrands(bytes)[0];
  if (!majorBrand || avifBrands.has(majorBrand)) return null;
  if (heicBrands.has(majorBrand)) return "image/heic";
  if (heifBrands.has(majorBrand)) return "image/heif";

  return null;
}

export function isHeicFile(fileName: string, mimeType = ""): boolean {
  const normalizedMimeType = mimeType.split(";", 1)[0]?.trim().toLowerCase();
  return (
    normalizedMimeType === "image/heic" ||
    normalizedMimeType === "image/heif" ||
    /\.(heic|heif)$/i.test(fileName)
  );
}

export function imageMimeLabel(fileName: string, mimeType = ""): string {
  if (isHeicFile(fileName, mimeType)) return "HEIC / HEIF";
  const resolved = inferSupportedImageMimeType(fileName, mimeType);
  return resolved ? resolved.replace("image/", "").toUpperCase() : "圖片";
}

export interface FoodImageInput {
  data: string;
  mimeType: SupportedImageMimeType;
}

export interface FoodVisionProvider {
  readonly id: string;
  readonly mode: "live" | "demo";
  analyzeImage(image: FoodImageInput): Promise<FoodAnalysis>;
}
