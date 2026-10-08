import type { FoodAnalysis, FoodEstimate, ObservedFood, PortionUnit } from "./food-analysis";
import type { NutritionMatch, NutritionProfile } from "@/lib/nutrition/types";
import { normalizeFoodName } from "@/lib/nutrition/canonical";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { isMilkTypeUncertainty, photoMilkChoiceByLabel } from "@/lib/nutrition/photo-milk";

export type PortionPreset = "small" | "regular" | "large";

export interface EditableFoodItem extends ObservedFood {
  id: string;
  originalPortionMin: number | null;
  originalPortionMax: number | null;
  nutritionMatch?: NutritionMatch | null;
  /**
   * Photo items come from a vision analysis. Manual items are typed.
   * Absent on meals saved before the photo milk confirmation.
   */
  entrySource?: "photo" | "manual";
}

export function hasKnownPortion<T extends ObservedFood>(food: T): food is T & FoodEstimate {
  return food.portionMin !== null && food.portionMax !== null;
}

export function renameFoodItem(
  food: EditableFoodItem,
  name: string,
  originalFood: ObservedFood = food,
): EditableFoodItem {
  const milkChoice = photoMilkChoiceByLabel(name);
  if (milkChoice) {
    return {
      ...food,
      displayName: milkChoice.displayName,
      normalizedName: milkChoice.normalizedName,
      identityLevel: "ingredient",
      preparationMethod: undefined,
      visibleIngredients: undefined,
      notes: undefined,
      nutritionMatch: null,
      uncertaintyReasons: food.uncertaintyReasons.filter((reason) => !isMilkTypeUncertainty(reason)),
    };
  }

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

export function assignEntrySource(
  items: EditableFoodItem[],
  analysis: FoodAnalysis | null,
): EditableFoodItem[] {
  const photoIds = new Set(createEditableFoodItems(analysis?.foods ?? []).map((item) => item.id));
  let changed = false;
  const next = items.map((item) => {
    if (item.entrySource) return item;
    changed = true;
    const entrySource = item.id.startsWith("manual-") || !photoIds.has(item.id) ? "manual" as const : "photo" as const;
    return { ...item, entrySource };
  });
  return changed ? next : items;
}

export function createEditableFoodItems(
  foods: ObservedFood[],
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

  // An unknown personal serving has no baseline from which a preset can be
  // calculated. Keep it unknown until the user supplies an amount.
  if (food.originalPortionMin === null || food.originalPortionMax === null) return food;

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
    if (food.portionMin === null || food.portionMax === null) return { ...food, unit: nextUnit };
    return {
      ...food,
      unit: nextUnit,
      portionMin: nextUnit === "g" || nextUnit === "ml" ? 100 : 1,
      portionMax: nextUnit === "g" || nextUnit === "ml" ? 150 : 2,
      originalPortionMin: nextUnit === "g" || nextUnit === "ml" ? 100 : 1,
      originalPortionMax: nextUnit === "g" || nextUnit === "ml" ? 150 : 2,
    };
  }

  if (food.portionMin === null || food.portionMax === null) return { ...food, unit: nextUnit };

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
