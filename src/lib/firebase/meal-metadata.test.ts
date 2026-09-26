import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { CURRENT_MEAL_SCHEMA_VERSION, newDraft, type MealRecord } from "@/lib/meals/types";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";

const fixture = vi.hoisted(() => ({ previous: vi.fn(), commit: vi.fn(), nutritionKey: vi.fn() }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  authenticated: async () => ({ db: {}, user: { id: "verified-user" } }),
}));
vi.mock("@/lib/firebase/meals", async (original) => ({
  ...(await original<typeof import("@/lib/firebase/meals")>()),
  previousMeal: fixture.previous,
  commitMeal: fixture.commit,
}));
vi.mock("@/lib/server/env", async (original) => ({
  ...(await original<typeof import("@/lib/server/env")>()),
  getNutritionApiKey: fixture.nutritionKey,
}));
import { assertWritableMealSchema } from "./meals";
import { POST } from "@/app/api/meals/route";

function input() {
  return {
    ...newDraft(),
    mutationId: crypto.randomUUID(),
    items: createEditableFoodItems(demoFoodAnalysis.foods),
  };
}
function request(body: unknown) {
  return new Request("http://localhost/api/meals", {
    method: "POST", body: JSON.stringify(body),
  });
}
beforeEach(() => {
  vi.restoreAllMocks();
  fixture.previous.mockReset().mockResolvedValue(undefined);
  fixture.nutritionKey.mockReset().mockReturnValue(undefined);
  fixture.commit.mockReset().mockImplementation(async (_db, _uid, record) => ({
    ...record,
    schemaVersion: CURRENT_MEAL_SCHEMA_VERSION,
    createdAt: "2026-09-26T10:00:00.000Z",
    updatedAt: "2026-09-26T10:00:00.000Z",
  }));
});

describe("meal schema write boundary", () => {
  it.each([undefined, {}, { schemaVersion: 0 }, { schemaVersion: 1 }])(
    "accepts the legacy/current schema %j",
    (record) => expect(() => assertWritableMealSchema(record)).not.toThrow(),
  );
  it.each([null, "1", -1, 0.5, 2, true, {}, [], NaN, Infinity])(
    "rejects unsupported stored schema %j",
    (schemaVersion) => {
      expect(() => assertWritableMealSchema({ schemaVersion })).toThrowError(
        expect.objectContaining({ status: 409, code: "unsupported_schema" }),
      );
    },
  );
  it("rejects a future record before any nutrition resolution or writer call", async () => {
    const body = input();
    fixture.previous.mockResolvedValue({
      deleted: false,
      record: { ...body, version: 1, mutationId: crypto.randomUUID(), schemaVersion: 2 },
    });
    const nutrition = vi.spyOn(LocalNutritionProvider.prototype, "resolve");
    const response = await POST(request({ ...body, version: 1, schemaVersion: 1 }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "unsupported_schema" } });
    expect(nutrition).not.toHaveBeenCalled();
    expect(fixture.nutritionKey).not.toHaveBeenCalled();
    expect(fixture.commit).not.toHaveBeenCalled();
  });
  it("acknowledges the same future-schema mutation without upgrading or enriching it", async () => {
    const body = input();
    const previous = { ...body, version: 1, schemaVersion: 2, createdAt: null, futureField: "retain" };
    fixture.previous.mockResolvedValue({ deleted: false, record: previous });
    const response = await POST(request(body));
    expect(response.status).toBe(200);
    expect((await response.json()).record).toEqual(previous);
    expect(fixture.nutritionKey).not.toHaveBeenCalled();
    expect(fixture.commit).not.toHaveBeenCalled();
  });
  it("strips untrusted metadata before the server writer chooses authoritative fields", async () => {
    const response = await POST(request({
      ...input(), schemaVersion: 200, createdAt: "1900-01-01T00:00:00.000Z",
      updatedAt: "1900-01-01T00:00:00.000Z", userId: "other-user",
    }));
    expect(response.status).toBe(200);
    const candidate = fixture.commit.mock.calls[0][2] as Partial<MealRecord>;
    expect(candidate.userId).toBe("verified-user");
    expect(candidate).not.toHaveProperty("schemaVersion");
    expect(candidate).not.toHaveProperty("createdAt");
    expect(candidate).not.toHaveProperty("updatedAt");
    expect((await response.json()).record.createdAt).toBe("2026-09-26T10:00:00.000Z");
  });
});
