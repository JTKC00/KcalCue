import { z } from "zod";

// Application pipeline contract, not a provider model or SDK version.
// Bump when the prompt, analysis schema or image/response processing changes.
export const FOOD_VISION_ANALYSIS_VERSION = "food-vision-v2";

const modelNameSchema = z.string().min(1).max(200).refine((value) => value.trim().length > 0);
export const analysisProvenanceMetadataSchema = z.object({
  provider: z.enum(["openai", "demo"]),
  requestedModel: modelNameSchema.nullable(),
  reportedModel: modelNameSchema.nullable(),
  // An alias or SDK response model is not evidence of model weights/version.
  modelVersion: z.null(),
  analysisVersion: z.string().min(1).max(64).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/),
  analyzedAt: z.iso.datetime().max(40),
}).refine((value) => value.provider !== "demo" ||
  (value.requestedModel === null && value.reportedModel === null));

export type AnalysisProvenanceMetadata = z.infer<typeof analysisProvenanceMetadataSchema>;
export type AnalysisProvenance = AnalysisProvenanceMetadata & { source: "client-reported" };

export function boundedModelName(value: unknown): string | null {
  const parsed = modelNameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Validated client echo only: unknown trust claims are stripped, never attested. */
export function readAnalysisProvenance(
  value: unknown,
  mode?: "live" | "demo" | "manual",
): AnalysisProvenance | null {
  const parsed = analysisProvenanceMetadataSchema.safeParse(value);
  if (!parsed.success || mode === "manual") return null;
  if (mode && parsed.data.provider !== (mode === "demo" ? "demo" : "openai")) return null;
  return { ...parsed.data, source: "client-reported" };
}
