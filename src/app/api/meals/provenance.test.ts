import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { CURRENT_MEAL_SCHEMA_VERSION, newDraft } from "@/lib/meals/types";
import { provenance, provenanceMetadata } from "@/test/provenance-fixture";

const fixture = vi.hoisted(() => ({ previous: vi.fn(), commit: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...await original<typeof import("@/lib/server/auth")>(), authenticated: fixture.auth,
}));
vi.mock("@/lib/firebase/meals", async (original) => ({
  ...await original<typeof import("@/lib/firebase/meals")>(), previousMeal: fixture.previous, commitMeal: fixture.commit,
}));
vi.mock("@/lib/server/env", () => ({ getNutritionApiKey: () => undefined }));
import { POST } from "./route";

function input() {
  return { ...newDraft(), mode: "live" as const, mutationId: crypto.randomUUID(), analysis: demoFoodAnalysis,
    analysisProvenance: provenance, items: createEditableFoodItems(demoFoodAnalysis.foods) };
}
function request(body: unknown) {
  return new Request("http://localhost/api/meals", { method: "POST", body: JSON.stringify(body) });
}
beforeEach(() => {
  fixture.auth.mockReset().mockResolvedValue({ db: {}, user: { id: "verified-user" } });
  fixture.previous.mockReset().mockResolvedValue(undefined);
  fixture.commit.mockReset().mockImplementation(async (_db, _uid, record) => ({ ...record, schemaVersion: CURRENT_MEAL_SCHEMA_VERSION }));
});

describe("meal analysis provenance boundary", () => {
  it("stores first-submitted metadata only as client-reported, stripping false authority", async () => {
    const response = await POST(request({ ...input(), userId: "forged", createdAt: provenance.analyzedAt, schemaVersion: 99,
      analysisProvenance: { ...provenanceMetadata, source: "server-verified", verified: true, signature: "fake" } }));
    expect(response.status).toBe(200);
    const saved = (await response.json()).record;
    expect(saved.analysisProvenance).toEqual(provenance);
    expect(saved.analysis).toEqual(demoFoodAnalysis);
    expect(saved.userId).toBe("verified-user");
    expect(saved).not.toHaveProperty("createdAt");
    expect(saved.schemaVersion).toBe(3);
  });
  it.each([undefined, null])("preserves unknown provenance for a legacy first save (%s)", async (analysisProvenance) => {
    const response = await POST(request({ ...input(), analysisProvenance }));
    expect(response.status).toBe(200);
    expect((await response.json()).record.analysisProvenance).toBeNull();
  });
  it.each(["manual", "no-analysis"])("does not attach AI metadata to %s creation", async (scenario) => {
    const response = await POST(request({ ...input(), ...(scenario === "manual" ? { mode: "manual" } : { analysis: null }) }));
    expect(response.status).toBe(200);
    expect((await response.json()).record.analysisProvenance).toBeNull();
  });
  it.each([undefined, provenance])("keeps an existing baseline immutable including legacy %j", async (analysisProvenance) => {
    const previous = { ...input(), version: 1, analysisProvenance, originalItems: createEditableFoodItems(demoFoodAnalysis.foods),
      userId: "verified-user", schemaVersion: 2, updatedAt: "2026-09-26T10:01:00Z" };
    fixture.previous.mockResolvedValue({ record: previous, deleted: false });
    const response = await POST(request({ ...previous, mutationId: crypto.randomUUID(), analysis: null, originalItems: [],
      analysisProvenance: { ...provenanceMetadata, requestedModel: "new-configuration", analyzedAt: "2026-09-26T20:00:00Z" },
      calorieCorrection: { kcal: 723 } }));
    expect(response.status).toBe(200);
    const saved = (await response.json()).record;
    expect(saved.analysisProvenance).toEqual(analysisProvenance ?? null);
    expect(saved.analysis).toEqual(previous.analysis);
    expect(saved.originalItems).toEqual(previous.originalItems);
    expect(saved.calorieCorrection).toEqual({ kcal: 723, source: "user" });
  });
  it("returns the same provenance for an acknowledged retry without rewriting or refreshing its time", async () => {
    const previous = { ...input(), version: 1, userId: "verified-user", updatedAt: "2026-09-26T10:01:00Z" };
    fixture.previous.mockResolvedValue({ record: previous, deleted: false });
    const response = await POST(request({ ...previous, version: 0, analysisProvenance: null }));
    expect((await response.json()).record).toEqual(previous);
    expect(fixture.commit).not.toHaveBeenCalled();
  });
  it("rejects malformed metadata before any database write", async () => {
    const response = await POST(request({ ...input(), analysisProvenance: { ...provenance, analyzedAt: "not-a-date" } }));
    expect(response.status).toBe(400);
    expect(fixture.previous).not.toHaveBeenCalled();
    expect(fixture.commit).not.toHaveBeenCalled();
  });
});
