import { describe, expect, it, vi } from "vitest";

import type { FoodEstimate } from "@/lib/domain/food-analysis";
import {
  calculateFoodNutrition,
  calculateMealNutrition,
  calculateNutritionRanges,
  portionRangeToGrams,
  roundRange,
} from "./calculation";
import { LocalNutritionProvider, normalizeFoodName } from "./local-provider";
import { NutritionService } from "./service";
import type { NutritionProfile, NutritionProvider } from "./types";

function makeFood(overrides: Partial<FoodEstimate> = {}): FoodEstimate {
  return {
    displayName: "測試食物",
    normalizedName: "test food",
    portionMin: 100,
    portionMax: 150,
    unit: "g",
    recognitionConfidence: 0.9,
    portionConfidence: 0.7,
    uncertaintyReasons: [],
    ...overrides,
  };
}

const profile: NutritionProfile = {
  id: "test-food",
  displayName: "測試食物",
  aliases: ["test food"],
  nutrientsPer100g: {
    calories: 200,
    protein: 20,
    carbs: 30,
    fat: 10,
  },
  gramsPerUnit: { g: 1, ml: 1.2, piece: 50 },
  dataNotice: "test fixture",
};

describe("portion unit conversion", () => {
  it.each([
    ["g", 80, 120, { min: 80, max: 120 }],
    ["piece", 2, 3, { min: 100, max: 150 }],
    ["ml", 100, 200, { min: 120, max: 240 }],
  ] as const)(
    "converts %s portions into grams",
    (unit, portionMin, portionMax, expected) => {
      expect(
        portionRangeToGrams(
          makeFood({ unit, portionMin, portionMax }),
          profile,
        ),
      ).toEqual(expected);
    },
  );

  it("returns null when the reference profile cannot convert the unit", () => {
    expect(portionRangeToGrams(makeFood({ unit: "bowl" }), profile)).toBeNull();
  });
});

describe("calorie and macronutrient ranges", () => {
  it("scales calories and every macro from per-100g values", () => {
    expect(
      calculateNutritionRanges(profile.nutrientsPer100g, {
        min: 100,
        max: 150,
      }),
    ).toEqual({
      calories: { min: 200, max: 300 },
      protein: { min: 20, max: 30 },
      carbs: { min: 30, max: 45 },
      fat: { min: 10, max: 15 },
    });
  });

  it("rounds the lower bound down and upper bound up to the chosen increment", () => {
    expect(roundRange({ min: 569.4, max: 762.35 }, 5)).toEqual({
      min: 565,
      max: 765,
    });
  });
});

describe("partial nutrition", () => {
  it("keeps known food totals and marks missing data as partial coverage", () => {
    const calculated = calculateFoodNutrition(makeFood(), profile);
    const missing = calculateFoodNutrition(
      makeFood({ displayName: "未知食物", normalizedName: "unknown food" }),
      null,
    );
    const meal = calculateMealNutrition([calculated, missing]);

    expect(meal.coverage).toBe("partial");
    expect(meal.totals).toEqual({
      calories: { min: 200, max: 300 },
      protein: { min: 20, max: 30 },
      carbs: { min: 30, max: 45 },
      fat: { min: 10, max: 15 },
    });
    expect(meal.midpointCalories).toBe(250);
    expect(missing.ranges).toBeNull();
    expect(missing.unavailableReason).toContain("未有這項食物");
  });

  it("reports no coverage when no food can be calculated", () => {
    const unavailable = calculateFoodNutrition(makeFood(), null);

    expect(calculateMealNutrition([unavailable])).toMatchObject({
      coverage: "none",
      midpointCalories: 0,
    });
  });

  it("distinguishes a missing unit conversion from a missing profile", () => {
    const result = calculateFoodNutrition(makeFood({ unit: "bowl" }), profile);

    expect(result.ranges).toBeNull();
    expect(result.unavailableReason).toContain("未有相應單位換算");
  });
});

describe("nutrition providers and service", () => {
  it("normalizes compatibility characters, case and whitespace for local lookup", () => {
    const provider = new LocalNutritionProvider();

    expect(normalizeFoodName("  ＷＨＩＴＥ   ＲＩＣＥ  ")).toBe("white rice");
    expect(provider.findByName("  ＷＨＩＴＥ   ＲＩＣＥ  ")?.id).toBe(
      "white-rice-cooked",
    );
    expect(provider.findByName("not in local data")).toBeNull();
  });

  it("falls back from normalized name to display name", () => {
    const findByName = vi.fn((name: string) =>
      name === "測試食物" ? profile : null,
    );
    const provider: NutritionProvider = {
      id: "stub",
      dataNotice: "stub",
      findByName,
      listFoods: () => [profile],
    };
    const service = new NutritionService(provider);

    const result = service.calculateMeal([
      makeFood({ normalizedName: "unmatched", displayName: "測試食物" }),
    ]);

    expect(findByName).toHaveBeenNthCalledWith(1, "unmatched");
    expect(findByName).toHaveBeenNthCalledWith(2, "測試食物");
    expect(result.coverage).toBe("complete");
    expect(result.totals.calories).toEqual({ min: 200, max: 300 });
  });
});
