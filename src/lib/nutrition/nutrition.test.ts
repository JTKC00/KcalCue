import { describe, expect, it, vi } from "vitest";

import type { FoodEstimate, ObservedFood } from "@/lib/domain/food-analysis";
import {
  calculateFoodNutrition,
  calculateMealNutrition,
  calculateNutritionRanges,
  classifyMealCoverage,
  mealShowsTotal,
  portionRangeToGrams,
  roundRange,
} from "./calculation";
import { canonicalizeFood, contradictoryDairyMilkLabel, normalizeFoodName } from "./canonical";
import { CREAM_MACARONI_UNCALCULATED_REASON } from "./negative-rules";
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
    identityLevel: "ingredient",
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

  it.each([
    ["橙汁", "orange juice"],
    ["果汁", "fruit juice"],
    ["椰汁", "coconut juice"],
  ] as const)("does not classify %s as savory sauce", (displayName, normalizedName) => {
    const food = makeFood({ displayName, normalizedName });
    const identity = canonicalizeFood(food);
    const match = resolveNutritionMatch(food, localNutritionProfiles);

    expect(identity.canonicalName).not.toBe("sauce");
    expect(identity.canonicalName).not.toBe("tomato-sauce");
    expect(match.profile?.id).not.toBe("savory-sauce");
    expect(match.matchType).toBe("unresolved");
    expect(match.includedInTotal).toBe(false);
  });

  it.each([
    ["茄汁", "tomato sauce", "tomato-sauce"],
    ["醬汁", "savory sauce", "savory-sauce"],
    ["豉油汁", "soy sauce", "savory-sauce"],
    ["汁", "juice", "savory-sauce"],
  ] as const)("keeps %s as a sauce identity", (displayName, normalizedName, profileId) => {
    const food = makeFood({ displayName, normalizedName });
    const identity = canonicalizeFood(food);
    const match = resolveNutritionMatch(food, localNutritionProfiles);

    expect(identity.category).toBe("sauce");
    expect(match.profile?.id).toBe(profileId);
    expect(match.includedInTotal).toBe(true);
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

  it("matches synonyms without requiring the exact provider output string", () => {
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

  it("does not mark an exact local food as included when its unit has no gram factor", () => {
    const match = provider.resolve(makeFood({
      displayName: "香蕉", normalizedName: "banana", unit: "ml",
    }));
    expect(match).toMatchObject({
      profile: null,
      matchType: "unresolved",
      includedInTotal: false,
    });
    expect(match.reasons[0]).toContain("ml");
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

describe("recognised protein vegetable salad estimation", () => {
  const provider = new LocalNutritionProvider();
  const service = new NutritionService(provider);

  it("turns the production salad-bowl identity into a wide kcal range", () => {
    const food = makeFood({
      displayName: "燒烤蛋白質雜菜沙律碗",
      normalizedName: "grilled protein mixed vegetable salad bowl",
      identityLevel: "dish",
      portionMin: 450,
      portionMax: 700,
      preparationMethod: "燒烤",
      visibleIngredients: ["grilled chicken", "mixed vegetables", "dressing"],
      recognitionConfidence: 0.9,
      portionConfidence: 0.7,
    });
    const match = provider.resolve(food);
    const meal = service.calculateMeal([food]);

    expect(canonicalizeFood(food).canonicalName).toBe("protein-vegetable-salad");
    expect(match.includedInTotal).toBe(true);
    expect(match.profile?.id).toBe("protein-vegetable-salad");
    expect(match.profile?.id).not.toBe("chicken-breast-cooked");
    expect(match.profile?.id).not.toBe("mixed-vegetables-stir-fried");
    expect(match.profile?.nutrientsPer100g.calories.min).toBeLessThan(
      match.profile?.nutrientsPer100g.calories.max ?? 0,
    );
    expect(meal.coverage).toBe("complete");
    expect(mealShowsTotal(meal.coverage)).toBe(true);
    expect(meal.totals.calories).toEqual({ min: 270, max: 1120 });
    expect(meal.totals.protein).toEqual({ min: 22.5, max: 105 });
    expect(meal.totals.carbs).toEqual({ min: 13.5, max: 70 });
    expect(meal.totals.fat).toEqual({ min: 6.75, max: 63 });
    expect(service.calculateMeal([food]).totals).toEqual(meal.totals);
  });

  it("does not let guessed visible ingredients promote an ambiguous salad", () => {
    const food = makeFood({
      displayName: "混合沙律",
      normalizedName: "mixed salad",
      identityLevel: "dish",
      visibleIngredients: ["rice", "chicken"],
    });
    const meal = service.calculateMeal([food]);

    expect(canonicalizeFood(food).canonicalName).toBe("mixed-dish");
    expect(meal.coverage).toBe("none");
    expect(meal.foods[0]?.ranges).toBeNull();
    expect(mealShowsTotal(meal.coverage)).toBe(false);
  });

  it.each([
    ["沙律", "salad", "ingredient", "unknown"],
    ["水果沙律", "fruit salad", "dish", "mixed-dish"],
    ["香蕉沙律", "banana salad", "dish", "mixed-dish"],
    ["薯仔沙律", "potato salad", "dish", "mixed-dish"],
  ] as const)("keeps %s unresolved", (displayName, normalizedName, identityLevel, canonicalName) => {
    const food = makeFood({ displayName, normalizedName, identityLevel });
    const meal = service.calculateMeal([food]);

    expect(canonicalizeFood(food).canonicalName).toBe(canonicalName);
    expect(meal.coverage).toBe("none");
    expect(meal.totals.calories).toEqual({ min: 0, max: 0 });
    expect(meal.foods[0]?.profile?.id).not.toBe("protein-vegetable-salad");
  });

  it("does not invent a total when the salad portion is unknown", () => {
    const food: ObservedFood = {
      ...makeFood({
        displayName: "燒烤蛋白質雜菜沙律碗",
        normalizedName: "grilled protein mixed vegetable salad bowl",
        identityLevel: "dish",
      }),
      portionMin: null,
      portionMax: null,
    };
    const meal = service.calculateMeal([food]);

    expect(provider.resolve({ ...food, portionMin: 450, portionMax: 700 }).includedInTotal).toBe(true);
    expect(meal.coverage).toBe("none");
    expect(meal.foods[0]?.ranges).toBeNull();
    expect(meal.foods[0]?.unavailableReason).toContain("個人食用份量未知");
  });

  it("does not calculate a meal the photo could not identify", () => {
    const meal = service.calculateMeal([]);
    expect(meal.coverage).toBe("none");
    expect(meal.totalCount).toBe(0);
    expect(mealShowsTotal(meal.coverage)).toBe(false);
  });

  it.each([
    ["雞胸沙拉", "chicken breast salad"],
    ["雜菜沙律", "mixed vegetable salad"],
    ["chicken salad no dressing", "chicken salad no dressing"],
  ])("keeps lean salad %s on the 60–160 profile", (displayName, normalizedName) => {
    const food = makeFood({ displayName, normalizedName, identityLevel: "dish" });
    const match = provider.resolve(food);

    expect(match.includedInTotal).toBe(true);
    expect(match.profile?.id).toBe("protein-vegetable-salad");
    expect(match.profile?.nutrientsPer100g.calories).toEqual({ min: 60, max: 160 });
  });

  it.each([
    ["沙律碗", "salad bowl"],
    ["沙律醬", "mayonnaise"],
    ["意粉沙律", "pasta salad"],
    ["雞肉沙律伴醬", "chicken salad with dressing"],
  ])("does not estimate %s", (displayName, normalizedName) => {
    const food = makeFood({ displayName, normalizedName, identityLevel: "dish" });
    const meal = service.calculateMeal([food]);

    expect(meal.coverage).toBe("none");
    expect(meal.foods[0]?.profile?.id).not.toBe("protein-vegetable-salad");
    expect(meal.foods[0]?.profile?.id).not.toBe("creamy-salad");
  });
});

describe("high-fat salad profile", () => {
  const provider = new LocalNutritionProvider();
  const service = new NutritionService(provider);
  const cited = [
    { id: "2706818", calories: 63, protein: 8.52, carbs: 2.99, fat: 1.94 },
    { id: "2709591", calories: 77, protein: 4, carbs: 7.49, fat: 3.41 },
    { id: "2708932", calories: 221, protein: 4.46, carbs: 24.6, fat: 11.5 },
    { id: "2708947", calories: 246, protein: 6.89, carbs: 21.8, fat: 14.4 },
    { id: "2707182", calories: 257, protein: 10.26, carbs: 1.01, fat: 23.14 },
  ] as const;

  it.each([
    ["凱撒沙律", "caesar salad"],
    ["凱撒雞沙律", "chicken caesar salad"],
    ["吞拿魚通粉沙律", "tuna macaroni salad"],
    ["蛋黃醬薯仔沙律", "potato salad with mayonnaise"],
    ["蛋黃醬蛋沙律", "egg mayo salad"],
    ["雜菜沙律伴沙律醬", "vegetable salad with mayonnaise"],
    ["芝士通粉沙律", "cheese macaroni salad"],
    ["千島醬沙律", "thousand island salad"],
    ["通粉沙律", "macaroni salad"],
    ["忌廉通粉", "macaroni salad"],
    ["忌廉通粉沙律", "macaroni salad"],
    ["凍忌廉通粉", "cold cream macaroni"],
    ["chicken mayo salad", "chicken mayo salad"],
  ])("estimates %s above the lean salad cap", (displayName, normalizedName) => {
    const food = makeFood({
      displayName,
      normalizedName,
      identityLevel: "dish",
      portionMin: 100,
      portionMax: 100,
    });
    const match = provider.resolve(food);
    const meal = service.calculateMeal([food]);
    const calories = match.profile?.nutrientsPer100g.calories;

    expect(canonicalizeFood(food).canonicalName).toBe("creamy-salad");
    expect(match.includedInTotal).toBe(true);
    expect(match.confidence).toBe("medium");
    expect(match.profile?.id).toBe("creamy-salad");
    expect(match.profile?.id).not.toBe("protein-vegetable-salad");
    expect(calories?.max).toBeGreaterThanOrEqual(246);
    expect(calories?.max).toBeGreaterThanOrEqual(257);
    expect(calories?.min).toBeLessThanOrEqual(63);
    expect(meal.coverage).toBe("complete");
    expect(meal.totals.calories.max).toBeGreaterThanOrEqual(246);
  });

  it("brackets the cited FDC points without treating the dish as pure mayonnaise", () => {
    const profile = provider.resolve(makeFood({
      displayName: "凱撒雞沙律",
      normalizedName: "chicken caesar salad",
      identityLevel: "dish",
    })).profile;
    expect(profile?.source.sourceId).toContain("2708947");
    expect(profile?.source.retrievedAt).toBe("2026-10-08");
    expect(profile?.source.attribution).toContain("FoodData Central");
    const band = profile?.nutrientsPer100g;
    expect(band).toBeTruthy();
    if (!band) return;
    for (const point of cited) {
      expect(band.calories.min).toBeLessThanOrEqual(point.calories);
      expect(band.calories.max).toBeGreaterThanOrEqual(point.calories);
      expect(band.protein.min).toBeLessThanOrEqual(point.protein);
      expect(band.protein.max).toBeGreaterThanOrEqual(point.protein);
      expect(band.carbs.min).toBeLessThanOrEqual(point.carbs);
      expect(band.carbs.max).toBeGreaterThanOrEqual(point.carbs);
      expect(band.fat.min).toBeLessThanOrEqual(point.fat);
      expect(band.fat.max).toBeGreaterThanOrEqual(point.fat);
    }
    expect(band.fat.max).toBeLessThan(74.85);
    expect(band.calories.max).toBeLessThan(680);
  });

  it("keeps the cited 63 kcal floor while a 100 g serving displays 60 after 5 kcal rounding", () => {
    const food = makeFood({
      displayName: "通粉沙律",
      normalizedName: "macaroni salad",
      identityLevel: "dish",
      portionMin: 100,
      portionMax: 100,
      unit: "g",
    });
    const calculated = service.calculateMeal([food]).foods[0];
    expect(calculated?.profile?.nutrientsPer100g.calories.min).toBe(63);
    expect(calculated?.ranges?.calories).toEqual({ min: 63, max: 257 });
    expect(roundRange(calculated?.ranges?.calories ?? { min: 0, max: 0 }, 5)).toEqual({
      min: 60,
      max: 260,
    });
    const slightlyUnder = calculateNutritionRanges(
      calculated?.profile?.nutrientsPer100g ?? {
        calories: { min: 63, max: 257 },
        protein: { min: 0, max: 0 },
        carbs: { min: 0, max: 0 },
        fat: { min: 0, max: 0 },
      },
      { min: 98, max: 98 },
    );
    expect(slightlyUnder.calories.min).toBeCloseTo(61.74, 2);
    expect(Math.round(slightlyUnder.calories.min)).toBe(62);
  });

  it("does not let a guessed dressing ingredient move the lean production bowl", () => {
    const food = makeFood({
      displayName: "燒烤蛋白質雜菜沙律碗",
      normalizedName: "grilled protein mixed vegetable salad bowl",
      identityLevel: "dish",
      visibleIngredients: ["grilled chicken", "mixed vegetables", "dressing"],
      portionMin: 450,
      portionMax: 700,
    });
    const meal = service.calculateMeal([food]);

    expect(provider.resolve(food).profile?.id).toBe("protein-vegetable-salad");
    expect(meal.totals.calories).toEqual({ min: 270, max: 1120 });
  });

  it("does not calculate hot or unspecified cream macaroni as a creamy salad", () => {
    const cases = [
      ["粟米忌廉通粉", "corn cream macaroni"],
      ["焗忌廉通粉", "baked cream macaroni"],
      ["忌廉汁通粉", "macaroni in cream sauce"],
      ["忌廉通粉", "hot cream macaroni"],
      ["忌廉通粉", "cream macaroni"],
      ["忌廉通心粉", "creamy macaroni"],
      ["焗忌廉通粉沙律", "baked macaroni salad"],
      ["粟米忌廉通粉", "macaroni salad"],
    ] as const;

    for (const [displayName, normalizedName] of cases) {
      const food = makeFood({
        displayName,
        normalizedName,
        identityLevel: "dish",
        portionMin: 100,
        portionMax: 100,
      });
      const match = provider.resolve(food);
      const meal = service.calculateMeal([food]);
      expect(canonicalizeFood(food).canonicalName, displayName).toBe("cream-macaroni");
      expect(match.identity.dishId, displayName).toBe("cream-macaroni");
      expect(match.identity.hasNutritionProfile, displayName).toBe(false);
      expect(match.profile, displayName).toBeNull();
      expect(match.includedInTotal, displayName).toBe(false);
      expect(match.matchType, displayName).toBe("unresolved");
      expect(match.coverageReason, displayName).toBe("DISH_KNOWN_NO_PROFILE");
      expect(match.reasons[0], displayName).toBe(CREAM_MACARONI_UNCALCULATED_REASON);
      expect(meal.coverage, displayName).toBe("none");
      expect(meal.totals.calories).toEqual({ min: 0, max: 0 });
    }
  });

  it("uses the creamy salad when cream macaroni is explicitly cold", () => {
    const noted = makeFood({
      displayName: "忌廉通粉",
      normalizedName: "cream macaroni",
      identityLevel: "dish",
      notes: "沙律",
      portionMin: 100,
      portionMax: 100,
    });
    const prepared = makeFood({
      displayName: "忌廉通心粉",
      normalizedName: "creamy macaroni",
      identityLevel: "dish",
      preparationMethod: "冷盤",
      portionMin: 100,
      portionMax: 100,
    });
    const calorieNote = makeFood({
      displayName: "通粉沙律",
      normalizedName: "macaroni salad",
      identityLevel: "dish",
      notes: "高熱量",
      portionMin: 100,
      portionMax: 100,
    });
    const creamCalorieNote = makeFood({
      displayName: "忌廉通粉沙律",
      normalizedName: "macaroni salad",
      identityLevel: "dish",
      notes: "高熱量",
      portionMin: 100,
      portionMax: 100,
    });
    const hotNote = makeFood({
      displayName: "忌廉通粉",
      normalizedName: "cream macaroni",
      identityLevel: "dish",
      notes: "熱食",
      portionMin: 100,
      portionMax: 100,
    });
    const hotEnglishNote = makeFood({
      displayName: "忌廉通粉",
      normalizedName: "cream macaroni",
      identityLevel: "dish",
      notes: "hot",
      portionMin: 100,
      portionMax: 100,
    });
    const cornAlone = makeFood({
      displayName: "凍忌廉通粉",
      normalizedName: "cold cream macaroni",
      identityLevel: "dish",
      notes: "corn",
      portionMin: 100,
      portionMax: 100,
    });
    const cornCjkAlone = makeFood({
      displayName: "凍忌廉通粉",
      normalizedName: "cold cream macaroni",
      identityLevel: "dish",
      notes: "粟米",
      portionMin: 100,
      portionMax: 100,
    });
    for (const food of [noted, prepared, calorieNote, creamCalorieNote, cornAlone, cornCjkAlone]) {
      const label = `${food.displayName} / ${food.notes ?? food.preparationMethod ?? ""}`;
      const match = provider.resolve(food);
      expect(canonicalizeFood(food).canonicalName, label).toBe("creamy-salad");
      expect(match.profile?.id, label).toBe("creamy-salad");
      expect(match.includedInTotal, label).toBe(true);
      expect(service.calculateMeal([food]).coverage, label).toBe("complete");
    }
    for (const food of [hotNote, hotEnglishNote]) {
      const hot = provider.resolve(food);
      expect(canonicalizeFood(food).canonicalName, food.notes).toBe("cream-macaroni");
      expect(hot.includedInTotal, food.notes).toBe(false);
      expect(hot.coverageReason, food.notes).toBe("DISH_KNOWN_NO_PROFILE");
    }
  });

  it("does not treat soy milk as whole milk", () => {
    const soy = provider.resolve(makeFood({ displayName: "豆漿", normalizedName: "soy milk" }));
    const milk = provider.resolve(makeFood({ displayName: "牛奶", normalizedName: "whole milk" }));
    const tea = provider.resolve(makeFood({
      displayName: "港式奶茶",
      normalizedName: "hong kong milk tea",
      identityLevel: "dish",
    }));

    expect(soy.includedInTotal).toBe(false);
    expect(soy.profile?.id).not.toBe("whole-milk");
    expect(canonicalizeFood(makeFood({ displayName: "豆漿", normalizedName: "soy milk" })).canonicalName).not.toBe("milk");
    expect(milk.profile?.id).toBe("whole-milk");
    expect(provider.resolve(makeFood({ displayName: "牛奶", normalizedName: "milk" })).profile?.id).toBe("whole-milk");
    expect(tea.profile?.id).toBe("milk-tea");
    for (const [displayName, normalizedName] of [
      ["燕麥奶", "oat milk"],
      ["椰奶", "coconut milk"],
      ["杏仁奶", "almond milk"],
    ] as const) {
      const match = provider.resolve(makeFood({ displayName, normalizedName }));
      expect(match.profile?.id).not.toBe("whole-milk");
      expect(match.includedInTotal).toBe(false);
    }
  });

  it("keeps dairy milk when oats or cereal are a separate food", () => {
    for (const [displayName, normalizedName, identityLevel] of [
      ["燕麥牛奶粥", "oatmeal with milk", "dish"],
      ["燕麥牛奶粥", "oatmeal with milk", "ingredient"],
      ["麥片加牛奶", "cereal with milk", "dish"],
      ["麥片加牛奶", "cereal with milk", "ingredient"],
    ] as const) {
      const item = makeFood({
        displayName,
        normalizedName,
        identityLevel,
        portionMin: 100,
        portionMax: 100,
        visibleIngredients: displayName.includes("麥片") ? ["麥片", "牛奶"] : ["燕麥", "牛奶"],
      });
      const match = provider.resolve(item);
      expect(contradictoryDairyMilkLabel(item), displayName).toBe(false);
      expect(canonicalizeFood(item).canonicalName, `${displayName} ${identityLevel}`).toBe("milk");
      expect(match.profile?.id, displayName).toBe("whole-milk");
      expect(match.includedInTotal, displayName).toBe(true);
    }

    const porridgeWithAlmond = makeFood({
      displayName: "燕麥牛奶粥",
      normalizedName: "oatmeal with milk",
      identityLevel: "dish",
      notes: "杏仁奶",
    });
    expect(contradictoryDairyMilkLabel(porridgeWithAlmond)).toBe(true);
    expect(provider.resolve(porridgeWithAlmond).profile?.id).not.toBe("whole-milk");

    const oats = makeFood({ displayName: "燕麥", normalizedName: "oats", portionMin: 40, portionMax: 40 });
    const dairy = makeFood({ displayName: "牛奶", normalizedName: "whole milk", portionMin: 100, portionMax: 100 });
    const cereal = makeFood({ displayName: "麥片", normalizedName: "cereal", portionMin: 40, portionMax: 40 });
    const separate = service.calculateMeal([oats, dairy, cereal]);
    expect(provider.resolve(oats).profile?.id).not.toBe("whole-milk");
    expect(provider.resolve(cereal).profile?.id).not.toBe("whole-milk");
    expect(provider.resolve(dairy).profile?.id).toBe("whole-milk");
    expect(separate.foods[1]?.includedInTotal).toBe(true);
    expect(separate.foods[1]?.ranges?.calories).toEqual({ min: 61, max: 61 });
    expect(separate.totals.calories).toEqual({ min: 61, max: 61 });
    expect(separate.includedCount).toBe(1);
  });
});
