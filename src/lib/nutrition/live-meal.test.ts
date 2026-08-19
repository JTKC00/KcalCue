import { describe, expect, it } from "vitest";

import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import type { FoodEstimate } from "@/lib/domain/food-analysis";
import { LocalNutritionProvider } from "./local-provider";
import { NutritionService } from "./service";
import { mealShowsTotal } from "./calculation";

const firstLiveMeal: FoodEstimate[] = [
  {
    displayName: "紅米白飯",
    normalizedName: "cooked red and white rice",
    portionMin: 150,
    portionMax: 200,
    unit: "g",
    recognitionConfidence: 0.9,
    portionConfidence: 0.75,
    uncertaintyReasons: ["米種比例未能由相片確定。"],
  },
  {
    displayName: "香煎雞胸肉",
    normalizedName: "pan-seared chicken breast",
    portionMin: 120,
    portionMax: 160,
    unit: "g",
    recognitionConfidence: 0.88,
    portionConfidence: 0.7,
    uncertaintyReasons: ["用油量未能由相片確定。"],
    preparationMethod: "香煎",
  },
  {
    displayName: "炒什錦蔬菜",
    normalizedName: "stir-fried mixed vegetables",
    portionMin: 60,
    portionMax: 90,
    unit: "g",
    recognitionConfidence: 0.84,
    portionConfidence: 0.68,
    uncertaintyReasons: ["炒菜吸油量未知。"],
    preparationMethod: "炒",
  },
  {
    displayName: "番茄風味醬汁",
    normalizedName: "tomato-style sauce",
    portionMin: 40,
    portionMax: 70,
    unit: "ml",
    recognitionConfidence: 0.72,
    portionConfidence: 0.6,
    uncertaintyReasons: ["醬汁糖油比例未知。"],
  },
];

describe("first live meal regression", () => {
  it("resolves the four natural names through the general pipeline", () => {
    const provider = new LocalNutritionProvider();
    const matches = firstLiveMeal.map((food) => provider.resolve(food));

    expect(matches.map((match) => match.identity.canonicalName)).toEqual([
      "rice",
      "chicken-breast",
      "mixed-vegetables",
      "tomato-sauce",
    ]);
    expect(matches.every((match) => match.includedInTotal)).toBe(true);
    expect(matches.map((match) => match.profile?.id)).toEqual([
      "rice-cooked-mixed",
      "chicken-breast-cooked",
      "mixed-vegetables-stir-fried",
      "tomato-sauce",
    ]);
    expect(matches.every((match) => match.profile?.source.attribution)).toBeTruthy();
    expect(matches.map((match) => match.confidence)).toEqual([
      "medium",
      "high",
      "high",
      "high",
    ]);

    const items = createEditableFoodItems(firstLiveMeal, matches);
    const meal = new NutritionService(provider).calculateMeal(items);

    expect(meal.coverage).toBe("complete");
    expect(mealShowsTotal(meal.coverage)).toBe(true);
    expect(meal.includedCount).toBe(4);
    expect(meal.totals.calories.min).toBeGreaterThan(250);
    expect(meal.totals.calories.max).toBeGreaterThan(meal.totals.calories.min);
    expect(items[0]?.nutritionMatch?.profile?.id).toBe("rice-cooked-mixed");

    const afterPortionEdit = new NutritionService(provider).calculateMeal([
      { ...items[0], portionMin: 180, portionMax: 220, nutritionMatch: items[0]?.nutritionMatch },
      ...items.slice(1),
    ]);
    expect(afterPortionEdit.totals.calories.min).toBeGreaterThan(meal.totals.calories.min);
  });
});
