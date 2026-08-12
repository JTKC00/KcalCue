import type { FoodEstimate } from "@/lib/domain/food-analysis";
import type { NutritionProfile, NutrientValues } from "./types";

export interface NutrientRange {
  min: number;
  max: number;
}

export interface NutritionRanges {
  calories: NutrientRange;
  protein: NutrientRange;
  carbs: NutrientRange;
  fat: NutrientRange;
}

export interface CalculatedFood {
  food: FoodEstimate;
  profile: NutritionProfile | null;
  ranges: NutritionRanges | null;
  unavailableReason?: string;
}

export interface CalculatedMeal {
  foods: CalculatedFood[];
  totals: NutritionRanges;
  midpointCalories: number;
  coverage: "complete" | "partial" | "none";
}

const emptyRanges = (): NutritionRanges => ({
  calories: { min: 0, max: 0 },
  protein: { min: 0, max: 0 },
  carbs: { min: 0, max: 0 },
  fat: { min: 0, max: 0 },
});

export function portionRangeToGrams(
  food: Pick<FoodEstimate, "portionMin" | "portionMax" | "unit">,
  profile: NutritionProfile,
): NutrientRange | null {
  const gramsPerUnit = profile.gramsPerUnit[food.unit];
  if (!gramsPerUnit || !Number.isFinite(gramsPerUnit)) return null;

  return {
    min: food.portionMin * gramsPerUnit,
    max: food.portionMax * gramsPerUnit,
  };
}

function scaleNutrientRange(
  per100g: number,
  grams: NutrientRange,
): NutrientRange {
  return {
    min: (per100g * grams.min) / 100,
    max: (per100g * grams.max) / 100,
  };
}

export function calculateNutritionRanges(
  nutrients: NutrientValues,
  grams: NutrientRange,
): NutritionRanges {
  return {
    calories: scaleNutrientRange(nutrients.calories, grams),
    protein: scaleNutrientRange(nutrients.protein, grams),
    carbs: scaleNutrientRange(nutrients.carbs, grams),
    fat: scaleNutrientRange(nutrients.fat, grams),
  };
}

export function calculateFoodNutrition(
  food: FoodEstimate,
  profile: NutritionProfile | null,
): CalculatedFood {
  if (!profile) {
    return {
      food,
      profile: null,
      ranges: null,
      unavailableReason: "本地參考資料未有這項食物，暫不計入總數。",
    };
  }

  const grams = portionRangeToGrams(food, profile);
  if (!grams) {
    return {
      food,
      profile,
      ranges: null,
      unavailableReason: "這項食物未有相應單位換算，暫不計入總數。",
    };
  }

  return {
    food,
    profile,
    ranges: calculateNutritionRanges(profile.nutrientsPer100g, grams),
  };
}

function addRange(target: NutrientRange, next: NutrientRange): void {
  target.min += next.min;
  target.max += next.max;
}

export function calculateMealNutrition(foods: CalculatedFood[]): CalculatedMeal {
  const totals = emptyRanges();
  let calculatedCount = 0;

  for (const food of foods) {
    if (!food.ranges) continue;
    calculatedCount += 1;
    addRange(totals.calories, food.ranges.calories);
    addRange(totals.protein, food.ranges.protein);
    addRange(totals.carbs, food.ranges.carbs);
    addRange(totals.fat, food.ranges.fat);
  }

  const coverage =
    calculatedCount === 0
      ? "none"
      : calculatedCount === foods.length
        ? "complete"
        : "partial";

  return {
    foods,
    totals,
    midpointCalories: (totals.calories.min + totals.calories.max) / 2,
    coverage,
  };
}

export function roundRange(
  range: NutrientRange,
  increment = 1,
): NutrientRange {
  return {
    min: Math.floor(range.min / increment) * increment,
    max: Math.ceil(range.max / increment) * increment,
  };
}
