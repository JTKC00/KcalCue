import { describe, expect, it } from "vitest";
import "fake-indexeddb/auto";
import { localMeals } from "./cache";
import {
  dayNutrition,
  localDate,
  mealInputSchema,
  newDraft,
  type MealRecord,
} from "./types";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";

describe("meal records and local drafts", () => {
  it("preserves the original local date independently of a later time zone", () => {
    const draft = newDraft();
    draft.date = "2026-09-08";
    draft.timezone = "Asia/Hong_Kong";
    expect(localDate(new Date(2026, 8, 8, 23, 59))).toBe("2026-09-08");
    expect(JSON.parse(JSON.stringify(draft)).date).toBe("2026-09-08");
  });
  it("validates calendar dates, mode, portions and timezone", () => {
    const input = {
      ...newDraft(),
      items: createEditableFoodItems(demoFoodAnalysis.foods),
      mutationId: crypto.randomUUID(),
    };
    expect(mealInputSchema.safeParse(input).success).toBe(true);
    for (const invalid of [
      { date: "2026-02-30" },
      { timezone: "invalid" },
      { mode: "demo" },
      { time: "25:00" },
      { items: [] },
    ])
      expect(mealInputSchema.safeParse({ ...input, ...invalid }).success).toBe(
        false,
      );
  });
  it("keeps unknown nutrition explicit and excludes demonstration meals", () => {
    const items = createEditableFoodItems(demoFoodAnalysis.foods);
    const record: MealRecord = {
      ...newDraft(),
      items,
      userId: "a",
      mutationId: crypto.randomUUID(),
      updatedAt: new Date().toISOString(),
    };
    const full = dayNutrition([record]);
    expect(full.includedCount).toBeGreaterThan(0);
    expect(dayNutrition([{ ...record, mode: "demo" }]).includedCount).toBe(0);
    const unknown = {
      ...items[0],
      displayName: "完全未知食物",
      normalizedName: "完全未知食物",
      nutritionMatch: null,
    };
    const partial = dayNutrition([{ ...record, items: [...items, unknown] }]);
    expect(partial.includedCount).toBeLessThan(partial.totalCount);
    expect(partial.totals).toEqual(full.totals);
    expect(dayNutrition([{ ...record, items: [unknown] }]).coverage).toBe(
      "none",
    );
  });
  it("restores a temporary image draft and clears only the signed-out account", async () => {
    const draft = {
      ...newDraft(),
      photo: new Blob(["compressed jpeg"], { type: "image/jpeg" }),
    };
    await localMeals.write("a", { records: [], draft, syncedAt: null });
    await localMeals.write("b", {
      records: [],
      draft: newDraft(),
      syncedAt: null,
    });
    expect((await localMeals.read("a")).draft?.id).toBe(draft.id);
    await localMeals.clear("a");
    expect((await localMeals.read("a")).draft).toBeNull();
    expect((await localMeals.read("b")).draft).not.toBeNull();
  });
  it("preserves read-only metadata with draft photos without treating it as writable input", async () => {
    const draft = {
      ...newDraft(), version: 3, schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      items: createEditableFoodItems(demoFoodAnalysis.foods),
      photo: new Blob(["draft photo"], { type: "image/jpeg" }),
    };
    await localMeals.write("metadata-account", { records: [], draft, syncedAt: null });
    const restored = (await localMeals.read("metadata-account")).draft!;
    expect(restored.createdAt).toBe(draft.createdAt);
    expect(restored.schemaVersion).toBe(1);
    expect(await restored.photo!.text()).toBe("draft photo");
    const command = mealInputSchema.parse({ ...restored, mutationId: crypto.randomUUID() });
    expect(command).not.toHaveProperty("createdAt");
    expect(command).not.toHaveProperty("schemaVersion");
    expect(command).not.toHaveProperty("photo");
    expect(newDraft()).not.toHaveProperty("createdAt");
    await localMeals.clear("metadata-account");
  });
});
