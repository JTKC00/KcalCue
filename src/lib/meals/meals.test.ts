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
import { provenance } from "@/test/provenance-fixture";

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
  it("isolates two tabs' drafts while either tab refreshes the same account", async () => {
    const uid = "two-tab-drafts";
    const first = { ...newDraft(), photo: new Blob(["A"], { type: "image/jpeg" }) };
    const second = { ...newDraft(), photo: new Blob(["B"], { type: "image/jpeg" }) };
    await localMeals.write(uid, { records: [], draft: null, syncedAt: null }, "tab-a");
    await localMeals.write(uid, { records: [], draft: null, syncedAt: null }, "tab-b");
    await localMeals.write(uid, { records: [], draft: first, syncedAt: null }, "tab-a");
    await localMeals.write(uid, { records: [], draft: null, syncedAt: "2026-09-28T00:00:00Z" }, "tab-b");
    expect((await localMeals.read(uid, "tab-a")).draft?.id).toBe(first.id);
    expect(await (await localMeals.read(uid, "tab-a")).draft?.photo?.text()).toBe("A");
    await localMeals.write(uid, { records: [], draft: second, syncedAt: null }, "tab-b");
    expect((await localMeals.read(uid, "tab-a")).draft?.id).toBe(first.id);
    expect((await localMeals.read(uid, "tab-b")).draft?.id).toBe(second.id);
    await localMeals.clear(uid, "tab-b");
    expect((await localMeals.read(uid, "tab-a")).draft?.id).toBe(first.id);
    expect((await localMeals.read(uid, "tab-b")).draft).toBeNull();
    await localMeals.clear(uid);
    expect((await localMeals.read(uid, "tab-a")).draft).toBeNull();
    expect((await localMeals.read(uid, "tab-b")).draft).toBeNull();
  });
  it("adopts an older account draft once without letting a new tab steal it", async () => {
    const uid = "legacy-tab-upgrade";
    const old = newDraft();
    await localMeals.write(uid, { records: [], draft: old, syncedAt: null });
    expect((await localMeals.read(uid, "first-tab")).draft?.id).toBe(old.id);
    expect((await localMeals.read(uid, "later-tab")).draft?.id).toBe(old.id);
    expect((await localMeals.read(uid)).draft?.id).toBe(old.id);
    await localMeals.clear(uid);
  });
  it("keeps a newer sibling draft when a stale copy is cleared", async () => {
    const uid = "stale-draft-clear";
    const first = newDraft();
    await localMeals.write(uid, { records: [], draft: first, syncedAt: null }, "tab-a");
    expect((await localMeals.read(uid, "tab-b")).draft?.id).toBe(first.id);
    const edited = { ...first, date: "2026-09-28" };
    await localMeals.write(uid, { records: [], draft: edited, syncedAt: null }, "tab-a");
    await localMeals.write(uid, { records: [], draft: null, syncedAt: null }, "tab-b");
    expect((await localMeals.read(uid, "fresh-tab")).draft).toEqual(edited);
    await localMeals.clear(uid);
  });
  it("keeps a newer sibling draft visible when an older copy is edited", async () => {
    const uid = "stale-draft-edit";
    const first = { ...newDraft(), date: "2026-09-27" };
    await localMeals.write(uid, { records: [], draft: first, syncedAt: null }, "tab-a");
    expect((await localMeals.read(uid, "tab-b")).draft).toEqual(first);
    const newer = { ...first, date: "2026-09-28" };
    await localMeals.write(uid, { records: [], draft: newer, syncedAt: null }, "tab-a");
    await localMeals.write(uid, {
      records: [], draft: { ...first, time: "12:30" }, syncedAt: null,
    }, "tab-b");
    expect((await localMeals.read(uid, "fresh-tab")).draft).toEqual(newer);
    expect((await localMeals.read(uid, "tab-b")).draft?.time).toBe("12:30");
    const variants = await localMeals.listDrafts(uid);
    expect(new Set(variants.map((variant) => variant.revision)).size).toBe(2);
    const olderFork = variants.find((variant) => variant.tabId === "tab-b")!;
    const restored = await localMeals.restoreDraft(uid, "fresh-tab", olderFork.tabId);
    expect(restored.time).toBe("12:30");
    expect((await localMeals.read(uid, "fresh-tab")).draft?.time).toBe("12:30");
    expect((await localMeals.read(uid, "later-tab")).draft?.time).toBe("12:30");
    await localMeals.write(uid, {
      records: [], draft: { ...first, time: "13:00" }, syncedAt: null,
    }, "tab-b");
    expect((await localMeals.read(uid, "another-tab")).draft?.time).toBe("12:30");
    await localMeals.clear(uid, "tab-b");
    expect((await localMeals.read(uid, "last-tab")).draft?.time).toBe("12:30");
    expect((await localMeals.listDrafts(uid)).some((variant) =>
      variant.tabId !== "fresh-tab" && variant.revision !== olderFork.revision)).toBe(true);
    await localMeals.clear(uid);
    expect(await localMeals.listDrafts(uid)).toEqual([]);
  });
  it("round-trips journal-note draft state without inventing it for legacy drafts", async () => {
    const uid = "journal-note-cache";
    const noted = { ...newDraft(), journalNote: "午餐後散步" };
    await localMeals.write(uid, { records: [], draft: noted, syncedAt: null });
    expect((await localMeals.read(uid)).draft?.journalNote).toBe("午餐後散步");

    const legacy = newDraft();
    await localMeals.write(uid, { records: [], draft: legacy, syncedAt: null });
    expect((await localMeals.read(uid)).draft).not.toHaveProperty("journalNote");
    await localMeals.clear(uid);
  });

  it("preserves read-only metadata with draft photos without treating it as writable input", async () => {
    const draft = {
      ...newDraft(), version: 3, schemaVersion: 1,
      createdAt: "2026-09-01T00:00:00.000Z",
      analysis: demoFoodAnalysis, analysisProvenance: provenance,
      calorieInput: "", calorieCorrection: null,
      items: createEditableFoodItems(demoFoodAnalysis.foods),
      photo: new Blob(["draft photo"], { type: "image/jpeg" }),
    };
    await localMeals.write("metadata-account", { records: [], draft, syncedAt: null });
    const restored = (await localMeals.read("metadata-account")).draft!;
    expect(restored.createdAt).toBe(draft.createdAt);
    expect(restored.schemaVersion).toBe(1);
    expect(restored.analysisProvenance).toEqual(provenance);
    expect(restored.analysis).toEqual(demoFoodAnalysis);
    expect(restored.calorieInput).toBe("");
    expect(restored.calorieCorrection).toBeNull();
    expect(await restored.photo!.text()).toBe("draft photo");
    const command = mealInputSchema.parse({ ...restored, mutationId: crypto.randomUUID() });
    expect(command).not.toHaveProperty("createdAt");
    expect(command).not.toHaveProperty("schemaVersion");
    expect(command).not.toHaveProperty("photo");
    expect(newDraft()).not.toHaveProperty("createdAt");
    expect(newDraft().analysisProvenance).toBeNull();
    await localMeals.clear("metadata-account");
  });
});
