import type { FoodEstimate, PortionUnit } from "./food-analysis";
import type { NutritionMatch, NutritionProfile } from "@/lib/nutrition/types";
import { normalizeFoodName } from "@/lib/nutrition/canonical";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";

export type PortionPreset = "small" | "regular" | "large";

export interface EditableFoodItem extends FoodEstimate {
  id: string;
  originalPortionMin: number;
  originalPortionMax: number;
  nutritionMatch?: NutritionMatch | null;
}

export function renameFoodItem(
  food: EditableFoodItem,
  name: string,
  originalFood: FoodEstimate = food,
): EditableFoodItem {
  if (normalizeFoodName(food.displayName) === normalizeFoodName(name)) {
    return { ...food, displayName: name };
  }

  const namedProfile = new LocalNutritionProvider().findByName(name);
  // Clear stale evidence, but only an exact whole-name catalog match can
  // downgrade an AI dish to an ingredient. Substrings such as "banana" in
  // "banana smoothie" are not enough. Use the original analysis so typing
  // through a valid ingredient cannot accidentally remove this safety gate.
  return {
    ...food,
    displayName: name,
    normalizedName: name,
    identityLevel: namedProfile
      ? namedProfile.composite ? "dish" : "ingredient"
      : originalFood.identityLevel,
    preparationMethod: undefined,
    visibleIngredients: undefined,
    notes: undefined,
    nutritionMatch: null,
  };
}

function roundPortion(value: number, unit: PortionUnit): number {
  const precision = unit === "g" || unit === "ml" ? 1 : 10;
  return Math.max(0.1, Math.round(value * precision) / precision);
}

export function createEditableFoodItems(
  foods: FoodEstimate[],
  matches: Array<NutritionMatch | null | undefined> = [],
): EditableFoodItem[] {
  return foods.map((food, index) => ({
    ...food,
    id: `${index}-${food.normalizedName.replace(/[^a-z0-9]+/gi, "-")}`,
    originalPortionMin: food.portionMin,
    originalPortionMax: food.portionMax,
    nutritionMatch: matches[index] ?? null,
  }));
}

export function applyPortionPreset(
  food: EditableFoodItem,
  preset: PortionPreset,
): EditableFoodItem {
  const factors: Record<PortionPreset, readonly [number, number]> = {
    small: [0.65, 0.8],
    regular: [1, 1],
    large: [1.25, 1.5],
  };
  const [minFactor, maxFactor] = factors[preset];

  return {
    ...food,
    portionMin: roundPortion(food.originalPortionMin * minFactor, food.unit),
    portionMax: roundPortion(food.originalPortionMax * maxFactor, food.unit),
  };
}

export function convertPortionUnit(
  food: EditableFoodItem,
  nextUnit: PortionUnit,
  profile: NutritionProfile | null,
): EditableFoodItem {
  if (food.unit === nextUnit) return food;

  const currentFactor = profile?.gramsPerUnit[food.unit];
  const nextFactor = profile?.gramsPerUnit[nextUnit];
  if (!currentFactor || !nextFactor) {
    return {
      ...food,
      unit: nextUnit,
      portionMin: nextUnit === "g" || nextUnit === "ml" ? 100 : 1,
      portionMax: nextUnit === "g" || nextUnit === "ml" ? 150 : 2,
      originalPortionMin: nextUnit === "g" || nextUnit === "ml" ? 100 : 1,
      originalPortionMax: nextUnit === "g" || nextUnit === "ml" ? 150 : 2,
    };
  }

  const portionMin = roundPortion(
    (food.portionMin * currentFactor) / nextFactor,
    nextUnit,
  );
  const portionMax = roundPortion(
    (food.portionMax * currentFactor) / nextFactor,
    nextUnit,
  );

  return {
    ...food,
    unit: nextUnit,
    portionMin,
    portionMax,
    originalPortionMin: portionMin,
    originalPortionMax: portionMax,
  };
}
