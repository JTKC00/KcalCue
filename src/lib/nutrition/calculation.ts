import type { FoodEstimate } from "@/lib/domain/food-analysis";
import type {
  MealCoverage,
  NutrientRange,
  NutrientRangePer100g,
  NutritionMatch,
  NutritionProfile,
} from "./types";
import { MEAL_TOTAL_COVERAGE_THRESHOLD } from "./types";

export type { NutrientRange, MealCoverage };

export interface NutritionRanges {
  calories: NutrientRange;
  protein: NutrientRange;
  carbs: NutrientRange;
  fat: NutrientRange;
}

export interface CalculatedFood {
  food: FoodEstimate;
  profile: NutritionProfile | null;
  match: NutritionMatch | null;
  ranges: NutritionRanges | null;
  includedInTotal: boolean;
  unavailableReason?: string;
}

export interface CalculatedMeal {
  foods: CalculatedFood[];
  totals: NutritionRanges;
  midpointCalories: number;
  coverage: MealCoverage;
  includedCount: number;
  totalCount: number;
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

function scaleDensityRange(
  density: NutrientRange,
  grams: NutrientRange,
): NutrientRange {
  return {
    min: (density.min * grams.min) / 100,
    max: (density.max * grams.max) / 100,
  };
}

export function calculateNutritionRanges(
  nutrients: NutrientRangePer100g,
  grams: NutrientRange,
): NutritionRanges {
  return {
    calories: scaleDensityRange(nutrients.calories, grams),
    protein: scaleDensityRange(nutrients.protein, grams),
    carbs: scaleDensityRange(nutrients.carbs, grams),
    fat: scaleDensityRange(nutrients.fat, grams),
  };
}

export function classifyMealCoverage(
  includedCount: number,
  totalCount: number,
): MealCoverage {
  if (totalCount === 0 || includedCount === 0) return "none";
  if (includedCount === totalCount) return "complete";
  if (includedCount / totalCount >= MEAL_TOTAL_COVERAGE_THRESHOLD) return "partial";
  return "insufficient";
}

export function mealShowsTotal(coverage: MealCoverage): boolean {
  return coverage === "complete" || coverage === "partial";
}

export function calculateFoodNutrition(
  food: FoodEstimate,
  match: NutritionMatch | null,
): CalculatedFood {
  const profile = match?.profile ?? null;
  if (!profile || !match?.includedInTotal) {
    return {
      food,
      profile,
      match,
      ranges: null,
      includedInTotal: false,
      unavailableReason:
        match?.reasons[0] ?? "未有足夠可靠的營養參考資料，暫不計入總數。",
    };
  }

  const grams = portionRangeToGrams(food, profile);
  if (!grams) {
    return {
      food,
      profile,
      match,
      ranges: null,
      includedInTotal: false,
      unavailableReason: "這項食物未有相應單位換算，暫不計入總數。",
    };
  }

  return {
    food,
    profile,
    match,
    ranges: calculateNutritionRanges(profile.nutrientsPer100g, grams),
    includedInTotal: true,
  };
}

function addRange(target: NutrientRange, next: NutrientRange): void {
  target.min += next.min;
  target.max += next.max;
}

export function calculateMealNutrition(foods: CalculatedFood[]): CalculatedMeal {
  const totals = emptyRanges();
  let includedCount = 0;

  for (const food of foods) {
    if (!food.ranges || !food.includedInTotal) continue;
    includedCount += 1;
    addRange(totals.calories, food.ranges.calories);
    addRange(totals.protein, food.ranges.protein);
    addRange(totals.carbs, food.ranges.carbs);
    addRange(totals.fat, food.ranges.fat);
  }

  return {
    foods,
    totals,
    midpointCalories: (totals.calories.min + totals.calories.max) / 2,
    coverage: classifyMealCoverage(includedCount, foods.length),
    includedCount,
    totalCount: foods.length,
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
