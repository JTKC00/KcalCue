import type { AnalysisProvenanceMetadata, AnalysisProvenance } from "@/lib/domain/analysis-provenance";

export const provenanceMetadata: AnalysisProvenanceMetadata = {
  provider: "openai",
  requestedModel: "test-requested-alias",
  reportedModel: "test-reported-model",
  modelVersion: null,
  analysisVersion: "food-vision-v1",
  analyzedAt: "2026-09-26T10:00:00.000Z",
};
export const provenance: AnalysisProvenance = { ...provenanceMetadata, source: "client-reported" };
