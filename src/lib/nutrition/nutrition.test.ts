import { describe, expect, it, vi } from "vitest";

import type { FoodEstimate } from "@/lib/domain/food-analysis";
import {
  calculateFoodNutrition,
  calculateMealNutrition,
  calculateNutritionRanges,
  classifyMealCoverage,
  mealShowsTotal,
  portionRangeToGrams,
  roundRange,
} from "./calculation";
import { canonicalizeFood, normalizeFoodName } from "./canonical";
import { LocalNutritionProvider } from "./local-provider";
import { resolveNutritionMatch } from "./resolver";
import { localNutritionProfiles } from "./local-data";
import { NutritionService } from "./service";
import {
  pointNutrient,
  type NutritionProfile,
  type NutritionProvider,
} from "./types";

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
  canonicalName: "test-food",
  category: "unknown",
  preparations: ["cooked"],
  aliases: ["test food"],
  composite: false,
  nutrientsPer100g: {
    calories: pointNutrient(200),
    protein: pointNutrient(20),
    carbs: pointNutrient(30),
    fat: pointNutrient(10),
  },
  gramsPerUnit: { g: 1, ml: 1.2, piece: 50 },
  source: {
    provider: "demo",
    sourceName: "test fixture",
    attribution: "test",
  },
  dataNotice: "test fixture",
  densityBasis: "point fixture",
};

function includedMatch(target: NutritionProfile) {
  return {
    profile: target,
    confidence: "high" as const,
    matchType: "exact_canonical" as const,
    reasons: ["fixture"],
    identity: {
      canonicalName: target.canonicalName,
      category: target.category,
      preparation: target.preparations[0] ?? "unknown",
      qualifiers: [],
    },
    includedInTotal: true,
  };
}

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
  it("scales point data as min = max density times portion range", () => {
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

  it("multiplies portion range by nutrient-density range", () => {
    expect(
      calculateNutritionRanges(
        {
          calories: { min: 180, max: 230 },
          protein: { min: 28, max: 32 },
          carbs: { min: 0, max: 1 },
          fat: { min: 3, max: 10 },
        },
        { min: 120, max: 160 },
      ),
    ).toEqual({
      calories: { min: 216, max: 368 },
      protein: { min: 33.6, max: 51.2 },
      carbs: { min: 0, max: 1.6 },
      fat: { min: 3.6, max: 16 },
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
  it("keeps known food totals and marks 1/2 coverage as insufficient", () => {
    const calculated = calculateFoodNutrition(makeFood(), includedMatch(profile));
    const missing = calculateFoodNutrition(
      makeFood({ displayName: "未知食物", normalizedName: "unknown food" }),
      {
        profile: null,
        confidence: "low",
        matchType: "unresolved",
        reasons: ["未有足夠可靠的營養參考資料可以配對。"],
        identity: {
          canonicalName: "unknown",
          category: "unknown",
          preparation: "unknown",
          qualifiers: [],
        },
        includedInTotal: false,
      },
    );
    const meal = calculateMealNutrition([calculated, missing]);

    expect(meal.coverage).toBe("insufficient");
    expect(mealShowsTotal(meal.coverage)).toBe(false);
    expect(meal.includedCount).toBe(1);
    expect(meal.totals.calories).toEqual({ min: 200, max: 300 });
    expect(missing.ranges).toBeNull();
  });

  it("shows a total when at least 75% of items are reliably matched", () => {
    const known = calculateFoodNutrition(makeFood(), includedMatch(profile));
    const missing = calculateFoodNutrition(makeFood({ displayName: "未知" }), {
      profile: null,
      confidence: "low",
      matchType: "unresolved",
      reasons: ["unresolved"],
      identity: {
        canonicalName: "unknown",
        category: "unknown",
        preparation: "unknown",
        qualifiers: [],
      },
      includedInTotal: false,
    });
    const meal = calculateMealNutrition([known, known, known, missing]);

    expect(classifyMealCoverage(3, 4)).toBe("partial");
    expect(meal.coverage).toBe("partial");
    expect(mealShowsTotal(meal.coverage)).toBe(true);
    expect(meal.includedCount).toBe(3);
  });

  it("reports no coverage when no food can be calculated", () => {
    const unavailable = calculateFoodNutrition(makeFood(), null);

    expect(calculateMealNutrition([unavailable])).toMatchObject({
      coverage: "none",
      midpointCalories: 0,
    });
  });

  it("distinguishes a missing unit conversion from a missing profile", () => {
    const result = calculateFoodNutrition(
      makeFood({ unit: "bowl" }),
      includedMatch(profile),
    );

    expect(result.ranges).toBeNull();
    expect(result.unavailableReason).toContain("未有相應單位換算");
  });
});

describe("canonicalization", () => {
  it("maps Chinese and English wording to the same identities", () => {
    expect(canonicalizeFood(makeFood({ displayName: "香煎雞胸肉", normalizedName: "pan-seared chicken breast" }))).toMatchObject({
      canonicalName: "chicken-breast",
      category: "poultry",
      preparation: "pan_fried",
    });
    expect(canonicalizeFood(makeFood({ displayName: "煎雞胸", normalizedName: "chicken breast" }))).toMatchObject({
      canonicalName: "chicken-breast",
    });
    expect(canonicalizeFood(makeFood({ displayName: "香草雞胸扒", normalizedName: "herb chicken breast" }))).toMatchObject({
      canonicalName: "chicken-breast",
    });
    expect(canonicalizeFood(makeFood({ displayName: "grilled chicken breast", normalizedName: "grilled chicken breast" }))).toMatchObject({
      canonicalName: "chicken-breast",
      preparation: "grilled",
    });
    expect(canonicalizeFood(makeFood({ displayName: "紅米白飯", normalizedName: "red and white rice" }))).toMatchObject({
      canonicalName: "rice",
      category: "rice",
    });
    expect(canonicalizeFood(makeFood({ displayName: "紅米白飯", normalizedName: "red and white rice" })).qualifiers).toContain("wholegrain");
    expect(canonicalizeFood(makeFood({ displayName: "炒什錦蔬菜", normalizedName: "stir-fried mixed vegetables" }))).toMatchObject({
      canonicalName: "mixed-vegetables",
      preparation: "stir_fried",
    });
    expect(canonicalizeFood(makeFood({ displayName: "番茄風味醬汁", normalizedName: "tomato flavored sauce" }))).toMatchObject({
      canonicalName: "tomato-sauce",
      category: "sauce",
    });
    expect(canonicalizeFood(makeFood({ displayName: "炒麵", normalizedName: "fried noodles" }))).toMatchObject({
      canonicalName: "fried-noodles",
      category: "mixed",
      preparation: "stir_fried",
      qualifiers: ["composite"],
    });
    expect(canonicalizeFood(makeFood({ displayName: "混合菜式", normalizedName: "mixed dish" }))).toMatchObject({
      canonicalName: "unknown",
      category: "unknown",
    });
  });

  it("normalizes punctuation and whitespace", () => {
    expect(normalizeFoodName("  ＷＨＩＴＥ   ＲＩＣＥ  ")).toBe("white rice");
    expect(normalizeFoodName("chicken-breast!!")).toBe("chicken breast");
  });
});

describe("nutrition matching", () => {
  const provider = new LocalNutritionProvider();

  it("still supports exact local names for Demo foods", () => {
    expect(provider.findByName("  ＷＨＩＴＥ   ＲＩＣＥ  ")?.id).toBe(
      "white-rice-cooked",
    );
    expect(provider.resolve(makeFood({ displayName: "白飯", normalizedName: "cooked white rice" }))).toMatchObject({
      matchType: "exact_canonical",
      includedInTotal: true,
      profile: { id: "white-rice-cooked" },
    });
  });

  it("matches synonyms without requiring the exact Gemini string", () => {
    const breast = provider.resolve(
      makeFood({ displayName: "煎雞胸", normalizedName: "chicken breast" }),
    );
    expect(breast.profile?.canonicalName).toBe("chicken-breast");
    expect(breast.includedInTotal).toBe(true);
    expect(["exact_canonical", "strong_synonym"]).toContain(breast.matchType);
  });

  it("keeps banana as a high-confidence exact identity", () => {
    const match = provider.resolve(
      makeFood({ displayName: "香蕉", normalizedName: "banana" }),
    );
    expect(match).toMatchObject({
      profile: { id: "banana" },
      confidence: "high",
      includedInTotal: true,
    });
  });

  it("does not treat generic curry as a reliable match", () => {
    const match = provider.resolve(
      makeFood({
        displayName: "港式咖喱牛腩",
        normalizedName: "hong kong beef curry",
      }),
    );
    expect(match.includedInTotal).toBe(false);
    expect(match.matchType).toBe("unresolved");
  });

  it("returns unresolved when nothing in the catalog is close", () => {
    expect(
      provider.resolve(
        makeFood({ displayName: "太空食品", normalizedName: "space food brick" }),
      ).matchType,
    ).toBe("unresolved");
  });

  it("does not use a low-confidence generic match in the meal total", () => {
    const match = resolveNutritionMatch(
      makeFood({ displayName: "某種青菜", normalizedName: "some greens" }),
      localNutritionProfiles,
    );
    if (match.matchType === "approximate_generic") {
      expect(match.includedInTotal).toBe(false);
    }
  });
});

describe("nutrition providers and service", () => {
  it("uses a cached match instead of looking up the name again", () => {
    const resolve = vi.fn();
    const provider: NutritionProvider = {
      id: "stub",
      dataNotice: "stub",
      resolve,
      findByName: vi.fn(),
      listFoods: () => [profile],
    };
    const service = new NutritionService(provider);
    const food = makeFood();
    const cached = includedMatch(profile);

    const result = service.calculateMeal([{ ...food, nutritionMatch: cached }]);

    expect(resolve).not.toHaveBeenCalled();
    expect(result.coverage).toBe("complete");
    expect(result.totals.calories).toEqual({ min: 200, max: 300 });
  });

  it("resolves via the provider when no cached match exists", () => {
    const provider = new LocalNutritionProvider();
    const service = new NutritionService(provider);
    const result = service.calculateMeal([
      makeFood({ displayName: "香蕉", normalizedName: "banana" }),
    ]);
    expect(result.coverage).toBe("complete");
    expect(result.foods[0]?.profile?.id).toBe("banana");
  });
});
