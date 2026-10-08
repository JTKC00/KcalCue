import type { NutrientRange, NutrientRangePer100g } from "./types";

export const RANGE_RATIO_FOLLOW_UP = 2.5;
export const RANGE_RATIO_COMPLETE_MAX = 3;

const EPSILON = 1e-6;

export interface GramRange {
  min: number;
  max: number;
}

export interface NutrientDensity {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface NutrientDensityRange {
  calories: GramRange;
  protein: GramRange;
  carbs: GramRange;
  fat: GramRange;
}

export interface RecipeComponentCalculation {
  grams: GramRange;
  nutrientsPer100g: NutrientDensityRange;
  gramsAtCalorieMin: number;
  gramsAtCalorieMax: number;
}

export interface RecipeCalculationInput {
  servingGrams: GramRange;
  components: RecipeComponentCalculation[];
}

export interface RecipeCalculation {
  feasible: boolean;
  feasibleGrams: GramRange;
  servingCalories: NutrientRange;
  servingProtein: NutrientRange;
  servingCarbs: NutrientRange;
  servingFat: NutrientRange;
  per100g: NutrientRangePer100g;
  /** max/min of the stored per-100 g calorie band. */
  rangeRatio: number;
  needsFollowUp: boolean;
  complete: boolean;
  components: RecipeComponentCalculation[];
}

export function densityRange(point: NutrientDensity, high?: NutrientDensity): NutrientDensityRange {
  const upper = high ?? point;
  return {
    calories: bounds(point.calories, upper.calories),
    protein: bounds(point.protein, upper.protein),
    carbs: bounds(point.carbs, upper.carbs),
    fat: bounds(point.fat, upper.fat),
  };
}

export function calculateRecipe(input: {
  servingGrams: GramRange;
  components: Array<Omit<RecipeComponentCalculation, "gramsAtCalorieMin" | "gramsAtCalorieMax">>;
}): RecipeCalculation {
  const components = input.components.map((component) => ({
    ...component,
    gramsAtCalorieMin: component.grams.min,
    gramsAtCalorieMax: component.grams.max,
  }));
  const sumMin = sum(components.map((component) => component.grams.min));
  const sumMax = sum(components.map((component) => component.grams.max));
  const low = Math.max(input.servingGrams.min, sumMin);
  const high = Math.min(input.servingGrams.max, sumMax);
  const empty = emptyCalculation(components, { min: low, max: high });
  if (low > high + EPSILON || components.length === 0) return empty;

  const calorieMinGrams = allocate(components, low, "calories", false);
  const calorieMaxGrams = allocate(components, high, "calories", true);
  components.forEach((component, index) => {
    component.gramsAtCalorieMin = round4(calorieMinGrams[index] ?? component.grams.min);
    component.gramsAtCalorieMax = round4(calorieMaxGrams[index] ?? component.grams.max);
  });

  const servingCalories = nutrientExtent(components, "calories", low, high);
  const servingProtein = nutrientExtent(components, "protein", low, high);
  const servingCarbs = nutrientExtent(components, "carbs", low, high);
  const servingFat = nutrientExtent(components, "fat", low, high);
  const referenceGrams = (low + high) / 2;
  const per100g: NutrientRangePer100g = {
    calories: per100(servingCalories, referenceGrams),
    protein: per100(servingProtein, referenceGrams),
    carbs: per100(servingCarbs, referenceGrams),
    fat: per100(servingFat, referenceGrams),
  };
  const rangeRatio = per100g.calories.min > 0
    ? round4(per100g.calories.max / per100g.calories.min)
    : Number.POSITIVE_INFINITY;

  return {
    feasible: true,
    feasibleGrams: { min: round4(low), max: round4(high) },
    servingCalories,
    servingProtein,
    servingCarbs,
    servingFat,
    per100g,
    rangeRatio,
    needsFollowUp: rangeRatio > RANGE_RATIO_FOLLOW_UP,
    complete: rangeRatio <= RANGE_RATIO_COMPLETE_MAX,
    components,
  };
}

function nutrientExtent(
  components: RecipeComponentCalculation[],
  key: keyof NutrientDensity,
  low: number,
  high: number,
): NutrientRange {
  const minGrams = allocate(components, low, key, false);
  const maxGrams = allocate(components, high, key, true);
  return {
    min: round1(dot(components, minGrams, key, "min")),
    max: round1(dot(components, maxGrams, key, "max")),
  };
}

function dot(
  components: RecipeComponentCalculation[],
  grams: number[],
  key: keyof NutrientDensity,
  end: "min" | "max",
): number {
  return components.reduce((total, component, index) => {
    const density = component.nutrientsPer100g[key][end];
    return total + ((grams[index] ?? 0) * density) / 100;
  }, 0);
}

function allocate(
  components: RecipeComponentCalculation[],
  total: number,
  key: keyof NutrientDensity,
  preferHigh: boolean,
): number[] {
  const grams = components.map((component) => component.grams.min);
  let remaining = total - sum(grams);
  const order = components
    .map((component, index) => ({
      index,
      density: component.nutrientsPer100g[key][preferHigh ? "max" : "min"],
    }))
    .sort((left, right) => preferHigh
      ? right.density - left.density || left.index - right.index
      : left.density - right.density || left.index - right.index);

  for (const item of order) {
    if (remaining <= EPSILON) break;
    const room = components[item.index]!.grams.max - grams[item.index]!;
    const add = Math.min(Math.max(room, 0), remaining);
    grams[item.index] = (grams[item.index] ?? 0) + add;
    remaining -= add;
  }
  if (remaining > 1e-3) {
    throw new Error("食譜模板的總重落在原料上下限之外");
  }
  return grams;
}

function per100(serving: NutrientRange, referenceGrams: number): NutrientRange {
  return {
    min: round1((serving.min / referenceGrams) * 100),
    max: round1((serving.max / referenceGrams) * 100),
  };
}

function emptyCalculation(
  components: RecipeComponentCalculation[],
  feasibleGrams: GramRange,
): RecipeCalculation {
  const zero = { min: 0, max: 0 };
  return {
    feasible: false,
    feasibleGrams,
    servingCalories: zero,
    servingProtein: zero,
    servingCarbs: zero,
    servingFat: zero,
    per100g: { calories: zero, protein: zero, carbs: zero, fat: zero },
    rangeRatio: Number.POSITIVE_INFINITY,
    needsFollowUp: true,
    complete: false,
    components,
  };
}

function bounds(left: number, right: number): GramRange {
  return { min: Math.min(left, right), max: Math.max(left, right) };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function round1(value: number): number {
  return Math.round((value + Number.EPSILON) * 10) / 10;
}

function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}
