import { describe, expect, it } from "vitest";
import { createEditableFoodItems, type EditableFoodItem } from "@/lib/domain/editable-meal";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { dayNutrition, mealInputSchema, newDraft, type MealRecord } from "./types";
import { calorieCorrectionInputSchema, dayCalories, mealCalories, resolveCalorieCorrection, sameCalorieBasis } from "./calories";

function referenceFood(id = "reference") {
  const item = { ...createEditableFoodItems(demoFoodAnalysis.foods)[0], id, portionMin: 100, portionMax: 100, unit: "g" as const };
  const match = new LocalNutritionProvider().resolve(item);
  if (!match.profile) throw new Error("Expected a known reference fixture");
  return { ...item, nutritionMatch: { ...match, includedInTotal: true, profile: {
    ...match.profile,
    nutrientsPer100g: { ...match.profile.nutrientsPer100g, calories: { min: 180, max: 220 } },
  } } };
}
function unknownFood() {
  const known = referenceFood("unknown");
  return { ...known, displayName: "完全未知", normalizedName: "unknown", nutritionMatch: {
    ...known.nutritionMatch, includedInTotal: false, profile: null,
  } };
}
function record(items: EditableFoodItem[] = [referenceFood()]): MealRecord {
  return { ...newDraft(), items, userId: "a", updatedAt: "2026-09-26T00:00:00.000Z", mutationId: crypto.randomUUID() };
}

describe("calorie correction input", () => {
  it.each([0, 650, 20_000])("accepts explicit whole-meal integer %s", (kcal) => {
    expect(calorieCorrectionInputSchema.parse({ kcal, source: "ai", protein: 50 })).toEqual({ kcal });
  });
  it.each([-1, 20_001, 1.5, NaN, Infinity, "650", "", null, undefined])("rejects invalid value %s without coercion", (kcal) => {
    expect(calorieCorrectionInputSchema.safeParse({ kcal }).success).toBe(false);
  });
  it("preserves omitted legacy intent, explicit clear and draft-only raw input boundaries", () => {
    const input = { ...newDraft(), items: [referenceFood()], mutationId: crypto.randomUUID(), calorieInput: "bad-input" };
    expect(newDraft().calorieCorrection).toBeNull();
    expect(mealInputSchema.parse(input).calorieCorrection).toBeNull();
    const legacy = { ...input, calorieCorrection: undefined };
    expect(mealInputSchema.parse(legacy).calorieCorrection).toBeUndefined();
    const command = mealInputSchema.parse({ ...input, calorieCorrection: { kcal: 0, source: "ai" } });
    expect(command.calorieCorrection).toEqual({ kcal: 0 });
    expect(command).not.toHaveProperty("calorieInput");
  });
});

describe("meal content basis and correction commands", () => {
  it("ignores order, resolver completion and confidence but preserves stable IDs", () => {
    const foods = [referenceFood("a"), referenceFood("b")];
    const next = foods.map((item) => ({
      ...item, normalizedName: "async resolver normalization", nutritionMatch: null,
      recognitionConfidence: 0.1, portionConfidence: 0.2, uncertaintyReasons: ["new warning"],
      originalPortionMin: 1, originalPortionMax: 2,
    })).reverse();
    expect(sameCalorieBasis(foods, next)).toBe(true);
    expect(sameCalorieBasis(foods, [foods[0], foods[0]])).toBe(false);
  });
  it.each([
    { id: "new-id" }, { displayName: "另一種食物" }, { identityLevel: "dish" as const },
    { portionMin: 99 }, { portionMax: 101 }, { unit: "ml" as const },
    { preparationMethod: "fried" }, { visibleIngredients: ["extra sauce"] },
  ])("detects changed content %j", (change) => {
    const food = referenceFood();
    expect(sameCalorieBasis([food], [{ ...food, ...change }])).toBe(false);
  });
  it("distinguishes set, clear and omitted commands without changing prior values", () => {
    const previous = { items: [referenceFood()], calorieCorrection: { kcal: 650, source: "user" as const } };
    expect(resolveCalorieCorrection(undefined, previous.items, previous)).toEqual(previous.calorieCorrection);
    expect(resolveCalorieCorrection(null, previous.items, previous)).toBeNull();
    expect(resolveCalorieCorrection({ kcal: 0 }, previous.items, previous)).toEqual({ kcal: 0, source: "user" });
    expect(resolveCalorieCorrection(undefined, [], previous)).toBeNull();
    expect(resolveCalorieCorrection(undefined, previous.items)).toBeNull();
    expect(previous.calorieCorrection.kcal).toBe(650);
  });
});

describe("final calories without fabricated macros", () => {
  it("persists an unknown personal serving without counting a known subtotal as the whole meal", () => {
    const unresolved = {
      ...referenceFood("shared-buffet"),
      portionMin: null, portionMax: null,
      originalPortionMin: null, originalPortionMax: null,
      nutritionMatch: null,
    };
    const meal = record([referenceFood("rice"), referenceFood("chicken"), referenceFood("veg"), unresolved]);
    const accepted = mealInputSchema.safeParse({ ...meal, mutationId: crypto.randomUUID() });
    expect(accepted.success).toBe(true);
    expect(mealCalories(meal)).toMatchObject({ range: null, source: "unknown", coverage: "insufficient" });
    expect(dayCalories([meal])).toMatchObject({ range: null, unknownCount: 1 });
    expect(mealCalories({ ...meal, calorieCorrection: { kcal: 650, source: "user" } })).toMatchObject({
      range: { min: 650, max: 650 }, source: "user",
    });
    expect(mealInputSchema.safeParse({ ...meal, mutationId: crypto.randomUUID(),
      items: [{ ...unresolved, portionMax: 100 }],
    }).success).toBe(false);
  });
  it("distinguishes complete reference, known partial calories and wholly unknown food", () => {
    const known = record();
    expect(mealCalories(known)).toMatchObject({ range: { min: 180, max: 220 }, source: "reference", coverage: "complete" });
    expect(mealCalories({ ...known, items: [...known.items, unknownFood()] })).toMatchObject({ range: null, coverage: "insufficient" });
    expect(mealCalories({ ...known, items: [referenceFood("a"), referenceFood("b"), referenceFood("c"), unknownFood()] })).toMatchObject({
      range: { min: 540, max: 660 }, coverage: "partial",
    });
    expect(mealCalories({ ...known, items: [unknownFood()] })).toMatchObject({ range: null, source: "unknown", coverage: "none" });
  });
  it("never treats insufficient known food as final whole-meal calories or adds it to the day", () => {
    const incomplete = record([referenceFood(), unknownFood()]);
    const complete = record();
    expect(mealCalories(incomplete)).toMatchObject({ range: null, source: "unknown", coverage: "insufficient" });
    expect(dayCalories([incomplete])).toMatchObject({ range: null, mealCount: 1, unknownCount: 1 });
    expect(dayCalories([complete, incomplete])).toMatchObject({
      range: { min: 180, max: 220 }, mealCount: 2, referenceCount: 1, unknownCount: 1,
    });
    expect(mealCalories({ ...incomplete, calorieCorrection: { kcal: 650, source: "user" } })).toMatchObject({
      range: { min: 650, max: 650 }, coverage: "complete", source: "user",
    });
  });
  it("uses an exact user-entered integer without rounding, reference double-counting or macro changes", () => {
    const before = record();
    const after = { ...before, calorieCorrection: { kcal: 723, source: "user" as const } };
    const original = structuredClone(before);
    expect(mealCalories(after)).toMatchObject({ range: { min: 723, max: 723 }, source: "user" });
    expect(dayCalories([after]).range).toEqual({ min: 723, max: 723 });
    expect(dayNutrition([after])).toEqual(dayNutrition([before]));
    expect(before).toEqual(original);
  });
  it("allows user zero over unresolved food while keeping macros unknown", () => {
    const meal = { ...record(), items: [unknownFood()], calorieCorrection: { kcal: 0, source: "user" as const } };
    expect(mealCalories(meal)).toMatchObject({ range: { min: 0, max: 0 }, coverage: "complete" });
    expect(dayCalories([meal])).toMatchObject({ range: { min: 0, max: 0 }, manualCount: 1, unknownCount: 0 });
    expect(dayNutrition([meal]).coverage).toBe("none");
    expect(mealCalories({ ...meal, calorieCorrection: null }).range).toBeNull();
  });
  it("sums mixed sources once, excludes demo meals and reports incomplete meals separately", () => {
    const known = record();
    const manual = { ...known, calorieCorrection: { kcal: 600, source: "user" as const } };
    const unknown = { ...known, items: [unknownFood()] };
    const demo = { ...manual, mode: "demo" as const };
    expect(dayCalories([known, manual, unknown, demo])).toEqual({
      range: { min: 780, max: 820 }, mealCount: 3, manualCount: 1,
      referenceCount: 1, partialCount: 0, unknownCount: 1, invalidCount: 0,
    });
    expect(dayCalories([{ ...known, items: [referenceFood("a"), referenceFood("b"), referenceFood("c"), unknownFood()] }]).partialCount).toBe(1);
    expect(dayCalories([unknown, demo]).range).toBeNull();
    expect(dayCalories([]).range).toBeNull();
  });
  it.each([{ kcal: NaN, source: "user" }, { kcal: 650, source: "ai" }, { kcal: "650", source: "user" }, {}, 0])(
    "fails closed for malformed persisted correction %j",
    (calorieCorrection) => {
      const meal = { ...record(), calorieCorrection };
      expect(mealCalories(meal)).toEqual({ range: null, source: "unknown", coverage: "none", invalidCorrection: true });
      expect(dayCalories([meal])).toMatchObject({ range: null, unknownCount: 1, invalidCount: 1 });
    },
  );
});
