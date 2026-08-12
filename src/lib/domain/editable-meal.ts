import type { FoodEstimate, PortionUnit } from "./food-analysis";
import type { NutritionProfile } from "@/lib/nutrition/types";

export type PortionPreset = "small" | "regular" | "large";

export interface EditableFoodItem extends FoodEstimate {
  id: string;
  originalPortionMin: number;
  originalPortionMax: number;
}

function roundPortion(value: number, unit: PortionUnit): number {
  const precision = unit === "g" || unit === "ml" ? 1 : 10;
  return Math.max(0.1, Math.round(value * precision) / precision);
}

export function createEditableFoodItems(
  foods: FoodEstimate[],
): EditableFoodItem[] {
  return foods.map((food, index) => ({
    ...food,
    id: `${index}-${food.normalizedName.replace(/[^a-z0-9]+/gi, "-")}`,
    originalPortionMin: food.portionMin,
    originalPortionMax: food.portionMax,
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
