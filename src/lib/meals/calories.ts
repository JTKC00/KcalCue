import { z } from "zod";
import type { EditableFoodItem } from "@/lib/domain/editable-meal";
import { NutritionService } from "@/lib/nutrition/service";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import type { NutrientRange } from "@/lib/nutrition/types";

export const MAX_MANUAL_KCAL = 20_000;
export const calorieCorrectionInputSchema = z.object({
  kcal: z.number().int().min(0).max(MAX_MANUAL_KCAL),
});
const storedCorrectionSchema = calorieCorrectionInputSchema.extend({
  source: z.literal("user"),
});
export type MealCalorieCorrection = z.infer<typeof storedCorrectionSchema>;

function foodBasis(items: readonly EditableFoodItem[]) {
  // Only meal content belongs here. Resolver metadata can change asynchronously.
  return items.map((item) => JSON.stringify([
    item.id,
    item.displayName.trim(),
    item.identityLevel,
    item.portionMin,
    item.portionMax,
    item.unit,
    item.preparationMethod?.trim() || null,
    (item.visibleIngredients ?? []).map((name) => name.trim()).sort(),
  ])).sort();
}

export function sameCalorieBasis(
  left: readonly EditableFoodItem[],
  right: readonly EditableFoodItem[],
): boolean {
  const a = foodBasis(left), b = foodBasis(right);
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/** Apply a validated command. Omission is legacy intent; null explicitly clears. */
export function resolveCalorieCorrection(
  input: { kcal: number } | null | undefined,
  items: readonly EditableFoodItem[],
  previous?: { items: readonly EditableFoodItem[]; calorieCorrection?: MealCalorieCorrection | null },
): MealCalorieCorrection | null {
  if (input !== undefined) return input === null ? null : { kcal: input.kcal, source: "user" };
  return previous && sameCalorieBasis(items, previous.items)
    ? previous.calorieCorrection ?? null
    : null;
}

export interface MealCalorieSummary {
  range: NutrientRange | null;
  source: "user" | "reference" | "unknown";
  coverage: "complete" | "partial" | "none";
  invalidCorrection: boolean;
}

interface CalorieMeal {
  items: EditableFoodItem[];
  mode: "live" | "manual" | "demo";
  calorieCorrection?: unknown;
}

export function mealCalories(meal: CalorieMeal): MealCalorieSummary {
  const unknown: MealCalorieSummary = {
    range: null, source: "unknown", coverage: "none", invalidCorrection: false,
  };
  if (meal.mode === "demo") return unknown;
  if (meal.calorieCorrection !== undefined && meal.calorieCorrection !== null) {
    const parsed = storedCorrectionSchema.safeParse(meal.calorieCorrection);
    if (!parsed.success) return { ...unknown, invalidCorrection: true };
    return {
      range: { min: parsed.data.kcal, max: parsed.data.kcal },
      source: "user", coverage: "complete", invalidCorrection: false,
    };
  }
  const reference = new NutritionService(new LocalNutritionProvider()).calculateMeal(meal.items);
  const range = reference.totals.calories;
  if (!reference.includedCount || !Number.isFinite(range.min) || !Number.isFinite(range.max)) return unknown;
  return {
    range: { ...range },
    source: "reference",
    coverage: reference.includedCount === reference.totalCount ? "complete" : "partial",
    invalidCorrection: false,
  };
}

export function dayCalories(records: CalorieMeal[]) {
  const meals = records.filter((record) => record.mode !== "demo");
  let range: NutrientRange | null = null;
  let manualCount = 0, referenceCount = 0, partialCount = 0, unknownCount = 0, invalidCount = 0;
  for (const meal of meals) {
    const summary = mealCalories(meal);
    if (summary.range) {
      range ??= { min: 0, max: 0 };
      range.min += summary.range.min;
      range.max += summary.range.max;
    }
    if (summary.source === "user") manualCount++;
    if (summary.source === "reference") referenceCount++;
    if (summary.coverage === "partial") partialCount++;
    if (summary.coverage === "none") unknownCount++;
    if (summary.invalidCorrection) invalidCount++;
  }
  return { range, mealCount: meals.length, manualCount, referenceCount, partialCount, unknownCount, invalidCount };
}
