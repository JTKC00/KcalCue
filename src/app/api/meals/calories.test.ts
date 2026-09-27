/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { newDraft } from "@/lib/meals/types";

const fixture = vi.hoisted(() => ({ previous: vi.fn(), commit: vi.fn(), auth: vi.fn() }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...await original<typeof import("@/lib/server/auth")>(), authenticated: fixture.auth,
}));
vi.mock("@/lib/firebase/meals", async (original) => ({
  ...await original<typeof import("@/lib/firebase/meals")>(),
  previousMeal: fixture.previous, commitMeal: fixture.commit,
}));
vi.mock("@/lib/server/env", () => ({ getNutritionApiKey: () => undefined }));
vi.mock("@/lib/server/meal-lookup-attempt", () => ({
  claimMealLookupAttempt: vi.fn().mockResolvedValue({ state: "claimed", token: "test-token" }),
  releaseMealLookupAttempt: vi.fn().mockResolvedValue(true),
}));
import { POST } from "./route";
import { HttpError } from "@/lib/server/auth";

function input() {
  return { ...newDraft(), mutationId: crypto.randomUUID(), items: createEditableFoodItems(demoFoodAnalysis.foods) };
}
function previousRecord() {
  const body = input();
  return { ...body, version: 1, schemaVersion: 2, userId: "verified-user", originalItems: body.items,
    analysis: demoFoodAnalysis, calorieCorrection: { kcal: 650, source: "user" as const },
    createdAt: "2026-09-01T00:00:00.000Z", updatedAt: "2026-09-02T00:00:00.000Z" };
}
function request(body: unknown) {
  return new Request("http://localhost/api/meals", { method: "POST", body: JSON.stringify(body) });
}
beforeEach(() => {
  fixture.auth.mockReset().mockResolvedValue({ db: {}, user: { id: "verified-user" } });
  fixture.previous.mockReset().mockResolvedValue(undefined);
  fixture.commit.mockReset().mockImplementation(async (_db, _uid, record) => ({ ...record, schemaVersion: 2 }));
});

describe("meal calorie correction commands", () => {
  it.each([0, 650, 20_000])("accepts %s kcal and assigns user provenance independently of client claims", async (kcal) => {
    const body = { ...input(), userId: "forged", calorieInput: "private raw input",
      calorieCorrection: { kcal, source: "ai", confidence: 1, protein: 40 } };
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    const saved = (await response.json()).record;
    expect(saved.calorieCorrection).toEqual({ kcal, source: "user" });
    expect(saved.userId).toBe("verified-user");
    expect(saved).not.toHaveProperty("calorieInput");
    expect(saved.items[0]).not.toHaveProperty("calorieCorrection");
    expect(fixture.commit.mock.calls[0][1]).toBe("verified-user");
  });
  it.each([-1, 20_001, 3.5, "650", "", null, { wrong: 10 }])("rejects invalid kcal %j before a write", async (kcal) => {
    const response = await POST(request({ ...input(), calorieCorrection: { kcal } }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request" } });
    expect(fixture.previous).not.toHaveBeenCalled();
    expect(fixture.commit).not.toHaveBeenCalled();
  });
  it("preserves original analysis and foods when updating or explicitly clearing the final value", async () => {
    const previous = previousRecord();
    fixture.previous.mockResolvedValue({ deleted: false, record: previous });
    for (const calorieCorrection of [{ kcal: 700 }, null]) {
      const response = await POST(request({ ...previous, mutationId: crypto.randomUUID(), analysis: null,
        originalItems: [], calorieCorrection }));
      expect(response.status).toBe(200);
      const saved = (await response.json()).record;
      expect(saved.calorieCorrection).toEqual(calorieCorrection && { ...calorieCorrection, source: "user" });
      expect(saved.analysis).toEqual(previous.analysis);
      expect(saved.originalItems).toEqual(previous.originalItems);
      expect(saved.version).toBe(2);
    }
  });
  it.each([false, true])("handles omitted legacy correction when food content changed=%s", async (changed) => {
    const previous = previousRecord();
    fixture.previous.mockResolvedValue({ deleted: false, record: previous });
    const response = await POST(request({ ...previous, mutationId: crypto.randomUUID(), time: "22:00",
      calorieCorrection: undefined, items: previous.items.map((food) => ({ ...food,
        normalizedName: "asynchronous catalog name", portionMin: changed ? food.portionMin + 0.1 : food.portionMin,
      })) }));
    expect(response.status).toBe(200);
    expect((await response.json()).record.calorieCorrection).toEqual(changed ? null : previous.calorieCorrection);
  });
  it("returns the accepted correction unchanged for a repeated mutation even with different retry content", async () => {
    const previous = previousRecord();
    fixture.previous.mockResolvedValue({ deleted: false, record: previous });
    const response = await POST(request({ ...previous, version: 0, calorieCorrection: null }));
    expect(response.status).toBe(200);
    expect((await response.json()).record).toEqual(previous);
    expect(fixture.commit).not.toHaveBeenCalled();
  });
  it("rejects stale correction edits and authentication failures without writing", async () => {
    const previous = previousRecord();
    fixture.previous.mockResolvedValue({ deleted: false, record: previous });
    expect((await POST(request({ ...previous, version: 0, mutationId: crypto.randomUUID(), calorieCorrection: { kcal: 0 } }))).status).toBe(409);
    fixture.auth.mockRejectedValueOnce(new HttpError(401, "login_required"));
    expect((await POST(request({ ...input(), calorieCorrection: { kcal: 650 } }))).status).toBe(401);
    expect(fixture.commit).not.toHaveBeenCalled();
  });
});
