import { describe, expect, it } from "vitest";
import { analysisProvenanceMetadataSchema, readAnalysisProvenance, boundedModelName } from "./analysis-provenance";
import { provenance, provenanceMetadata } from "@/test/provenance-fixture";

describe("analysis provenance is a bounded client claim, not attestation", () => {
  it("strips claimed authority while retaining exact request/response identifiers", () => {
    const claimed = { ...provenanceMetadata, source: "server-verified", verified: true, signature: "fake" };
    expect(readAnalysisProvenance(claimed, "live")).toEqual(provenance);
    expect(analysisProvenanceMetadataSchema.parse(claimed)).toEqual(provenanceMetadata);
  });
  it.each([undefined, null, {}, { ...provenanceMetadata, analyzedAt: "2026-02-30T10:00:00Z" },
    { ...provenanceMetadata, provider: "untrusted" }, { ...provenanceMetadata, requestedModel: "x".repeat(201) },
    { ...provenanceMetadata, reportedModel: "x".repeat(201) }, { ...provenanceMetadata, analysisVersion: "x".repeat(65) },
    { ...provenanceMetadata, modelVersion: "sdk-7.9" }, { ...provenanceMetadata, analysisVersion: "" },
  ])("keeps missing or malformed metadata unknown: %j", (value) => {
    expect(readAnalysisProvenance(value)).toBeNull();
  });
  it("does not infer weights versions or confuse live, demo and manual sources", () => {
    expect(readAnalysisProvenance({ ...provenanceMetadata, reportedModel: null }, "live"))
      .toMatchObject({ reportedModel: null, modelVersion: null });
    expect(readAnalysisProvenance(provenance, "manual")).toBeNull();
    expect(readAnalysisProvenance(provenance, "demo")).toBeNull();
    const demo = { ...provenanceMetadata, provider: "demo" as const, requestedModel: null, reportedModel: null };
    expect(readAnalysisProvenance(demo, "demo")).toMatchObject({ provider: "demo", modelVersion: null });
    expect(readAnalysisProvenance({ ...demo, reportedModel: "pretend-model" })).toBeNull();
    const gemini = { ...provenanceMetadata, provider: "gemini" as const, requestedModel: "gemini-3.8-flash", reportedModel: "gemini-3.8-flash" };
    expect(readAnalysisProvenance(gemini, "live")).toMatchObject({ provider: "gemini", source: "client-reported" });
    expect(readAnalysisProvenance(gemini, "demo")).toBeNull();
    expect(boundedModelName(undefined)).toBeNull();
    expect(boundedModelName(" ")).toBeNull();
    expect(boundedModelName("x".repeat(201))).toBeNull();
  });
});
