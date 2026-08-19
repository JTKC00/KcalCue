import type { FoodEstimate, PortionUnit } from "@/lib/domain/food-analysis";

export type NutritionMatchType =
  | "exact_canonical"
  | "strong_synonym"
  | "category_preparation"
  | "approximate_generic"
  | "unresolved";

export type NutritionConfidence = "high" | "medium" | "low";

export type FoodCategory =
  | "rice"
  | "noodles"
  | "bread"
  | "poultry"
  | "beef"
  | "pork"
  | "seafood"
  | "egg"
  | "vegetable"
  | "fruit"
  | "tofu"
  | "dairy"
  | "sauce"
  | "fried"
  | "mixed"
  | "unknown";

export type FoodPreparation =
  | "raw"
  | "cooked"
  | "steamed"
  | "boiled"
  | "pan_fried"
  | "grilled"
  | "stir_fried"
  | "deep_fried"
  | "sauced"
  | "unknown";

export type NutritionProviderId = "kcalcue-reference" | "usda-fdc" | "demo";

export type MealCoverage = "complete" | "partial" | "insufficient" | "none";

export interface CanonicalFoodIdentity {
  canonicalName: string;
  category: FoodCategory;
  preparation: FoodPreparation;
  qualifiers: string[];
}

export interface NutrientRange {
  min: number;
  max: number;
}

export interface NutrientRangePer100g {
  calories: NutrientRange;
  protein: NutrientRange;
  carbs: NutrientRange;
  fat: NutrientRange;
}

export interface NutritionSource {
  provider: NutritionProviderId;
  sourceId?: string;
  sourceName: string;
  retrievedAt?: string;
  attribution: string;
}

export interface NutritionProfile {
  id: string;
  displayName: string;
  canonicalName: string;
  category: FoodCategory;
  preparations: FoodPreparation[];
  aliases: string[];
  composite: boolean;
  nutrientsPer100g: NutrientRangePer100g;
  gramsPerUnit: Partial<Record<PortionUnit, number>>;
  source: NutritionSource;
  dataNotice: string;
  densityBasis: string;
}

export interface NutritionMatch {
  profile: NutritionProfile | null;
  confidence: NutritionConfidence;
  matchType: NutritionMatchType;
  reasons: string[];
  identity: CanonicalFoodIdentity;
  includedInTotal: boolean;
}

export interface NutritionProvider {
  readonly id: string;
  readonly dataNotice: string;
  resolve(food: FoodEstimate): NutritionMatch;
  findByName(name: string): NutritionProfile | null;
  listFoods(): NutritionProfile[];
}

export const INCLUDED_NUTRITION_CONFIDENCE: NutritionConfidence[] = [
  "high",
  "medium",
];

export const MEAL_TOTAL_COVERAGE_THRESHOLD = 0.75;

export function pointNutrient(value: number): NutrientRange {
  return { min: value, max: value };
}

export function nutrientBand(
  calories: readonly [number, number],
  protein: readonly [number, number],
  carbs: readonly [number, number],
  fat: readonly [number, number],
): NutrientRangePer100g {
  return {
    calories: { min: calories[0], max: calories[1] },
    protein: { min: protein[0], max: protein[1] },
    carbs: { min: carbs[0], max: carbs[1] },
    fat: { min: fat[0], max: fat[1] },
  };
}
