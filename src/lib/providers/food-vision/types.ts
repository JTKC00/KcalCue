import type { FoodAnalysis } from "@/lib/domain/food-analysis";

export const supportedImageMimeTypes = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

export type SupportedImageMimeType = (typeof supportedImageMimeTypes)[number];

export interface FoodImageInput {
  data: string;
  mimeType: SupportedImageMimeType;
}

export interface FoodVisionProvider {
  readonly id: string;
  readonly mode: "live" | "demo";
  analyzeImage(image: FoodImageInput): Promise<FoodAnalysis>;
}
