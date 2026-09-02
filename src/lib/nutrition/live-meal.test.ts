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
    identityLevel: "ingredient",
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
    identityLevel: "ingredient",
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
    identityLevel: "ingredient",
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
    identityLevel: "ingredient",
    portionMin: 40,
    portionMax: 70,
    unit: "ml",
    recognitionConfidence: 0.72,
    portionConfidence: 0.6,
    uncertaintyReasons: ["醬汁糖油比例未知。"],
  },
];

const secondLiveMeal: FoodEstimate[] = [
  {
    displayName: "墨魚汁意大利飯",
    normalizedName: "squid ink risotto",
    identityLevel: "dish",
    portionMin: 180,
    portionMax: 260,
    unit: "g",
    recognitionConfidence: 0.9,
    portionConfidence: 0.72,
    uncertaintyReasons: ["牛油、高湯、芝士及墨魚汁用量未能由相片確定。"],
  },
  {
    displayName: "香煎帶子",
    normalizedName: "pan-seared scallops",
    identityLevel: "ingredient",
    portionMin: 80,
    portionMax: 120,
    unit: "g",
    recognitionConfidence: 0.86,
    portionConfidence: 0.65,
    uncertaintyReasons: ["帶子實際重量及用油量未知。"],
    preparationMethod: "香煎",
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

describe("second live meal regression", () => {
  it("does not invent risotto or scallop calories from generic fallbacks", () => {
    const provider = new LocalNutritionProvider();
    const matches = secondLiveMeal.map((food) => provider.resolve(food));

    expect(matches.map((match) => match.identity.canonicalName)).toEqual([
      "risotto",
      "unknown",
    ]);
    expect(matches.map((match) => match.identity.qualifiers.includes("composite"))).toEqual([
      true,
      false,
    ]);
    expect(matches.every((match) => match.includedInTotal)).toBe(false);
    expect(matches.map((match) => match.matchType)).toEqual(["unresolved", "unresolved"]);
    expect(matches[0]?.profile).toBeNull();
    expect(matches[0]?.reasons[0]).toContain("不足以代表整道菜");
    expect(matches[1]?.profile).toBeNull();

    const items = createEditableFoodItems(secondLiveMeal, matches);
    const meal = new NutritionService(provider).calculateMeal(items);

    expect(meal.coverage).toBe("none");
    expect(mealShowsTotal(meal.coverage)).toBe(false);
    expect(meal.includedCount).toBe(0);
    expect(meal.totals.calories).toEqual({ min: 0, max: 0 });
  });
});
