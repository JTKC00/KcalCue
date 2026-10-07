import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import {
  CURRENT_MEAL_SCHEMA_VERSION, NULLABLE_PORTION_MEAL_SCHEMA_VERSION,
  newDraft, type MealRecord,
} from "@/lib/meals/types";
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
vi.mock("@/lib/server/meal-lookup-attempt", () => ({
  claimMealLookupAttempt: vi.fn().mockResolvedValue({ state: "claimed", token: "test-token" }),
  releaseMealLookupAttempt: vi.fn().mockResolvedValue(true),
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
    photoRef: record.photoRef ?? null,
    journalNote: record.journalNote ?? null,
    createdAt: "2026-09-26T10:00:00.000Z",
    updatedAt: "2026-09-26T10:00:00.000Z",
  }));
});

describe("meal schema write boundary", () => {
  it.each([undefined, {}, { schemaVersion: 0 }, { schemaVersion: 1 }, { schemaVersion: 2 }, { schemaVersion: 3 }])(
    "accepts the legacy/current schema %j",
    (record) => expect(() => assertWritableMealSchema(record)).not.toThrow(),
  );
  it.each([null, "1", -1, 0.5, CURRENT_MEAL_SCHEMA_VERSION + 1, true, {}, [], NaN, Infinity])(
    "rejects unsupported stored schema %j",
    (schemaVersion) => {
      expect(() => assertWritableMealSchema({ schemaVersion })).toThrowError(
        expect.objectContaining({ status: 409, code: "unsupported_schema" }),
      );
    },
  );
  it.each([4, NULLABLE_PORTION_MEAL_SCHEMA_VERSION])(
    "accepts protected pre-note version %s only with its explicit photo reference field",
    (version) => {
      expect(() => assertWritableMealSchema({ schemaVersion: version, photoRef: null })).not.toThrow();
      expect(() => assertWritableMealSchema({ schemaVersion: version })).toThrowError(
        expect.objectContaining({ status: 409, code: "unsupported_schema" }),
      );
      expect(() => assertWritableMealSchema({
        schemaVersion: version, photoRef: null, journalNote: "future note",
      })).toThrowError(expect.objectContaining({ status: 409, code: "unsupported_schema" }));
    },
  );
  it("requires the current schema to carry canonical photo and journal-note fields", () => {
    expect(() => assertWritableMealSchema({
      schemaVersion: CURRENT_MEAL_SCHEMA_VERSION, photoRef: null, journalNote: null,
    })).not.toThrow();
    expect(() => assertWritableMealSchema({
      schemaVersion: CURRENT_MEAL_SCHEMA_VERSION, photoRef: null, journalNote: "已保存",
    })).not.toThrow();
    for (const record of [
      { schemaVersion: CURRENT_MEAL_SCHEMA_VERSION, photoRef: null },
      { schemaVersion: CURRENT_MEAL_SCHEMA_VERSION, journalNote: null },
      { schemaVersion: CURRENT_MEAL_SCHEMA_VERSION, photoRef: null, journalNote: " 非 canonical " },
    ]) {
      expect(() => assertWritableMealSchema(record)).toThrowError(
        expect.objectContaining({ status: 409, code: "unsupported_schema" }),
      );
    }
  });
  it("preserves an existing journal note when an old request omits the field", async () => {
    const base = input();
    const previous: MealRecord = {
      ...base,
      userId: "verified-user",
      mutationId: crypto.randomUUID(),
      version: 1,
      updatedAt: "2026-10-07T00:00:00.000Z",
      schemaVersion: CURRENT_MEAL_SCHEMA_VERSION,
      createdAt: "2026-10-07T00:00:00.000Z",
      photoRef: null,
      journalNote: "朋友聚餐",
      calorieCorrection: { kcal: 650, source: "user" },
      originalItems: base.items,
    };
    fixture.previous.mockResolvedValue({ deleted: false, record: previous });
    const response = await POST(request({
      ...base,
      version: 1,
      mutationId: crypto.randomUUID(),
      calorieCorrection: undefined,
      journalNote: undefined,
    }));
    expect(response.status).toBe(200);
    const candidate = fixture.commit.mock.calls[0][2] as Partial<MealRecord>;
    expect(candidate.journalNote).toBe("朋友聚餐");
    expect(candidate.calorieCorrection).toEqual(previous.calorieCorrection);
    expect(candidate.analysis).toEqual(previous.analysis);
    expect(candidate.originalItems).toEqual(previous.originalItems);
  });
  it("normalizes and clears explicit journal-note input while preserving omission semantics", async () => {
    const base = input();
    const previous: MealRecord = {
      ...base,
      userId: "verified-user",
      mutationId: crypto.randomUUID(),
      version: 1,
      updatedAt: "2026-10-07T00:00:00.000Z",
      schemaVersion: CURRENT_MEAL_SCHEMA_VERSION,
      createdAt: "2026-10-07T00:00:00.000Z",
      photoRef: null,
      journalNote: "舊備註",
      originalItems: base.items,
    };
    fixture.previous.mockResolvedValue({ deleted: false, record: previous });

    const normalized = await POST(request({
      ...base, version: 1, mutationId: crypto.randomUUID(),
      journalNote: "  第一行\r\n第二行  ",
    }));
    expect(normalized.status).toBe(200);
    expect((fixture.commit.mock.calls.at(-1)?.[2] as MealRecord).journalNote)
      .toBe("第一行\n第二行");

    fixture.commit.mockClear();
    const cleared = await POST(request({
      ...base, version: 1, mutationId: crypto.randomUUID(), journalNote: null,
    }));
    expect(cleared.status).toBe(200);
    expect((fixture.commit.mock.calls.at(-1)?.[2] as MealRecord).journalNote).toBeNull();
  });
  it("rejects a journal note above 500 Unicode code points before the writer", async () => {
    const response = await POST(request({
      ...input(), journalNote: "🧸".repeat(501),
    }));
    expect(response.status).toBe(400);
    expect(fixture.commit).not.toHaveBeenCalled();
  });
  it("rejects a future record before any nutrition resolution or writer call", async () => {
    const body = input();
    fixture.previous.mockResolvedValue({
      deleted: false,
      record: { ...body, version: 1, mutationId: crypto.randomUUID(), schemaVersion: CURRENT_MEAL_SCHEMA_VERSION + 1 },
    });
    const nutrition = vi.spyOn(LocalNutritionProvider.prototype, "resolve");
    const response = await POST(request({ ...body, version: 1, schemaVersion: 1 }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "unsupported_schema" } });
    expect(nutrition).not.toHaveBeenCalled();
    expect(fixture.nutritionKey).not.toHaveBeenCalled();
    expect(fixture.commit).not.toHaveBeenCalled();
  });
  it("rejects a changed journal note when a committed mutation ID is reused", async () => {
    const body = input();
    const previous = {
      ...body,
      userId: "verified-user",
      version: 1,
      mutationId: body.mutationId,
      schemaVersion: CURRENT_MEAL_SCHEMA_VERSION,
      photoRef: null,
      journalNote: "已提交備註",
      createdAt: "2026-10-07T00:00:00.000Z",
      updatedAt: "2026-10-07T00:00:00.000Z",
    };
    fixture.previous.mockResolvedValue({ deleted: false, record: previous });

    const changed = await POST(request({ ...body, journalNote: "另一段備註" }));
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: { code: "conflict" } });
    expect(fixture.commit).not.toHaveBeenCalled();

    const same = await POST(request({ ...body, journalNote: "  已提交備註  " }));
    expect(same.status).toBe(200);
    expect((await same.json()).record).toEqual(previous);

    const legacyRetry = { ...body } as Record<string, unknown>;
    delete legacyRetry.journalNote;
    const omitted = await POST(request(legacyRetry));
    expect(omitted.status).toBe(200);
    expect((await omitted.json()).record).toEqual(previous);
  });

  it("acknowledges the same future-schema mutation without upgrading or enriching it", async () => {
    const body = input();
    const previous = { ...body, version: 1, schemaVersion: CURRENT_MEAL_SCHEMA_VERSION + 1, createdAt: null, futureField: "retain" };
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
