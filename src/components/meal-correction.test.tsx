/** @vitest-environment jsdom */

import "../test/setup";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { foodEstimateSchema, type FoodAnalysis } from "@/lib/domain/food-analysis";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import type { NutritionMatch } from "@/lib/nutrition/types";
import { newDraft, type MealDraft, type MealRecord } from "@/lib/meals/types";
import { KcalCueApp } from "./kcalcue-app";

const mocks = vi.hoisted(() => ({
  previousMeal: vi.fn(),
  commitMeal: vi.fn(async (_db, _uid, record) => record),
  pending: [] as Array<{ resolve: (match: NutritionMatch) => void; local: NutritionMatch }>,
}));
vi.mock("@/lib/server/auth", async (original) => ({
  ...await original<typeof import("@/lib/server/auth")>(),
  authenticated: async () => ({ db: {}, user: { id: "correction-test-user" } }),
}));
vi.mock("@/lib/firebase/meals", async (original) => ({
  ...(await original<typeof import("@/lib/firebase/meals")>()),
  previousMeal: mocks.previousMeal,
  commitMeal: mocks.commitMeal,
}));
vi.mock("@/lib/server/env", () => ({ getNutritionApiKey: () => null }));
vi.mock("@/lib/server/meal-lookup-attempt", () => ({
  claimMealLookupAttempt: vi.fn().mockResolvedValue({ state: "claimed", token: "test-token" }),
  releaseMealLookupAttempt: vi.fn().mockResolvedValue(true),
}));
vi.mock("@/lib/nutrition/client", async (original) => ({
  ...await original<typeof import("@/lib/nutrition/client")>(),
  resolveNutritionMatchWithFallback: vi.fn((_food, local) => new Promise((resolve) => {
    mocks.pending.push({ resolve, local });
  })),
}));
import { POST } from "@/app/api/meals/route";

const provider = new LocalNutritionProvider();
function draft(): MealDraft {
  const analysis: FoodAnalysis = {
    analysisStatus: "success",
    foods: [{
      displayName: "混合沙律",
      normalizedName: "mixed salad",
      identityLevel: "dish",
      portionMin: 100,
      portionMax: 150,
      unit: "g",
      recognitionConfidence: 0.5,
      portionConfidence: 0.5,
      uncertaintyReasons: ["請確認份量。"],
      preparationMethod: "grilled",
      visibleIngredients: ["rice", "chicken"],
      notes: "原始 AI 食材推測。",
    }],
    uncertaintyReasons: [],
    visibleEvidence: ["測試餐點"],
    estimatedInformation: ["估計份量"],
    unknownInformation: [],
  };
  const items = createEditableFoodItems(analysis.foods, analysis.foods.map(food => provider.resolve(foodEstimateSchema.parse(food))));
  return { ...newDraft(), mode: "live", analysis, items, originalItems: structuredClone(items) };
}

describe("meal identity correction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.pending.length = 0;
    vi.stubGlobal("scrollTo", vi.fn());
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("saves a real UI correction without the old AI identity and preserves the original analysis", async () => {
    const original = draft();
    const changed = vi.fn();
    render(<KcalCueApp initialProviderMode="live" initialDraft={original} onDraftChange={changed} />);
    fireEvent.change(screen.getByLabelText("食物名稱"), { target: { value: "香蕉" } });
    const correction = changed.mock.lastCall![0];
    const item = correction.items[0];
    expect(item.nutritionMatch.profile.id).toBe("banana");
    expect(item.nutritionMatch.includedInTotal).toBe(true);
    expect(item.preparationMethod).toBeUndefined();
    expect(item.visibleIngredients).toBeUndefined();
    expect(item.notes).toBeUndefined();
    expect(item.portionMin).toBe(100);
    expect(item.portionMax).toBe(150);
    expect(screen.getByRole("heading", { name: /約 .*kcal/ })).toBeInTheDocument();
    expect(correction.analysis).toEqual(original.analysis);

    const previous: MealRecord = { ...original, userId: "correction-test-user", version: 1, updatedAt: "2026-09-26T00:00:00.000Z", mutationId: crypto.randomUUID() };
    mocks.previousMeal.mockResolvedValue({ record: previous });
    const response = await POST(new Request("http://localhost/api/meals", {
      method: "POST",
      body: JSON.stringify({ ...original, ...correction, version: 1, mutationId: crypto.randomUUID() }),
    }));
    expect(response.status).toBe(200);
    const { record } = await response.json();
    expect(record.version).toBe(2);
    expect(record.items[0].nutritionMatch.profile.id).toBe("banana");
    expect(record.analysis).toEqual(previous.analysis);
    expect(record.originalItems).toEqual(previous.originalItems);
    expect(mocks.commitMeal).toHaveBeenCalledOnce();
  });

  it("retains AI context when only whitespace changes", () => {
    const original = draft();
    const changed = vi.fn();
    render(<KcalCueApp initialProviderMode="live" initialDraft={original} onDraftChange={changed} />);
    fireEvent.change(screen.getByLabelText("食物名稱"), { target: { value: "  混合沙律  " } });
    expect(changed.mock.lastCall![0].items[0]).toMatchObject({
      identityLevel: "dish",
      preparationMethod: "grilled",
      visibleIngredients: ["rice", "chicken"],
      notes: original.items[0].notes,
    });
  });

  it.each(["banana salad", "香蕉沙律", "墨魚汁意大利飯", "banana smoothie", "banana split"])(
    "does not turn a corrected composite %s into one base ingredient",
    (name) => {
      const changed = vi.fn();
      render(<KcalCueApp initialProviderMode="live" initialDraft={draft()} onDraftChange={changed} />);
      fireEvent.change(screen.getByLabelText("食物名稱"), { target: { value: name } });
      expect(changed.mock.lastCall![0].items[0].nutritionMatch.includedInTotal).toBe(false);
      expect(changed.mock.lastCall![0].items[0].nutritionMatch.profile?.canonicalName).not.toBe("banana");
      expect(screen.getByRole("heading", { name: "暫未能計算" })).toBeInTheDocument();
    },
  );

  it.each(["chicken breast salad", "雞胸沙拉"])(
    "estimates %s as a salad range instead of plain chicken",
    (name) => {
      const changed = vi.fn();
      render(<KcalCueApp initialProviderMode="live" initialDraft={draft()} onDraftChange={changed} />);
      fireEvent.change(screen.getByLabelText("食物名稱"), { target: { value: name } });
      const match = changed.mock.lastCall![0].items[0].nutritionMatch;
      expect(match.includedInTotal).toBe(true);
      expect(match.profile.id).toBe("protein-vegetable-salad");
      expect(match.profile.canonicalName).not.toBe("chicken-breast");
      expect(screen.getByRole("heading", { name: /約 .*kcal/ })).toBeInTheDocument();
    },
  );

  it("keeps the original dish safeguard when typing through a known ingredient", () => {
    const changed = vi.fn();
    render(<KcalCueApp initialProviderMode="live" initialDraft={draft()} onDraftChange={changed} />);
    const name = "banana smoothie";
    for (let length = 1; length <= name.length; length++) {
      fireEvent.change(screen.getByLabelText("食物名稱"), { target: { value: name.slice(0, length) } });
      if (length === "banana".length) {
        expect(changed.mock.lastCall![0].items[0].nutritionMatch.includedInTotal).toBe(true);
      }
    }
    expect(changed.mock.lastCall![0].items[0].nutritionMatch.includedInTotal).toBe(false);
  });

  it.each([true, false])("preserves dish safeguards after reopening a correction (analysis available: %s)", (withAnalysis) => {
    const original = draft();
    const changed = vi.fn();
    const first = render(<KcalCueApp initialProviderMode="live" initialDraft={original} onDraftChange={changed} />);
    fireEvent.change(screen.getByLabelText("食物名稱"), { target: { value: "banana" } });
    const reopened = { ...original, ...changed.mock.lastCall![0], analysis: withAnalysis ? original.analysis : null };
    first.unmount();
    render(<KcalCueApp initialProviderMode="live" initialDraft={reopened} onDraftChange={changed} />);
    fireEvent.change(screen.getByLabelText("食物名稱"), { target: { value: "banana split" } });
    expect(changed.mock.lastCall![0].items[0].nutritionMatch.includedInTotal).toBe(false);
  });

  it("ignores an old A response after the user changes A to B and back to A", async () => {
    const changed = vi.fn();
    render(<KcalCueApp initialProviderMode="live" initialDraft={draft()} onDraftChange={changed} />);
    for (const name of ["穀物飲品甲", "穀物飲品乙", "穀物飲品甲"]) {
      fireEvent.change(screen.getByLabelText("食物名稱"), { target: { value: name } });
      await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    }
    expect(mocks.pending).toHaveLength(3);
    await act(async () => { mocks.pending[2].resolve({ ...mocks.pending[2].local, reasons: ["最新結果"] }); });
    await act(async () => { mocks.pending[0].resolve({ ...mocks.pending[0].local, reasons: ["舊結果"] }); });
    expect(changed.mock.lastCall![0].items[0].nutritionMatch.reasons).toEqual(["最新結果"]);
  });

  it("cancels a queued name lookup and ignores an in-flight result when the portion becomes unknown", async () => {
    const changed = vi.fn();
    render(<KcalCueApp initialProviderMode="live" initialDraft={draft()} onDraftChange={changed} />);
    const name = screen.getByLabelText("食物名稱");
    const min = screen.getByLabelText("最少份量");
    fireEvent.change(name, { target: { value: "穀物飲品甲" } });
    fireEvent.change(min, { target: { value: "" } });
    fireEvent.blur(min);
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(mocks.pending).toHaveLength(0);
    expect(changed.mock.lastCall![0].items[0]).toMatchObject({ portionMin: null, portionMax: null, nutritionMatch: null });

    fireEvent.change(min, { target: { value: "100" } });
    fireEvent.blur(min);
    fireEvent.change(name, { target: { value: "穀物飲品乙" } });
    await act(async () => { await vi.advanceTimersByTimeAsync(350); });
    expect(mocks.pending).toHaveLength(1);
    fireEvent.change(min, { target: { value: "" } });
    fireEvent.blur(min);
    await act(async () => { mocks.pending[0].resolve({ ...mocks.pending[0].local, reasons: ["過時結果"] }); });
    expect(changed.mock.lastCall![0].items[0]).toMatchObject({ portionMin: null, portionMax: null, nutritionMatch: null });
  });
});
