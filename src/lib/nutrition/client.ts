import type { FoodEstimate } from "@/lib/domain/food-analysis";
import type { NutritionMatch } from "./types";

export interface NutritionResolveResponse {
  matches?: NutritionMatch[];
  provider?: string;
  error?: { code?: string };
}

export async function enrichUnresolvedMatches(
  foods: FoodEstimate[],
  localMatches: NutritionMatch[],
): Promise<NutritionMatch[]> {
  const unresolvedIndexes = localMatches
    .map((match, index) => (match.includedInTotal ? -1 : index))
    .filter((index) => index >= 0);

  if (unresolvedIndexes.length === 0) return localMatches;

  try {
    const response = await fetch("/api/nutrition/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        foods: unresolvedIndexes.map((index) => {
          const food = foods[index];
          return {
            displayName: food.displayName,
            normalizedName: food.normalizedName,
            portionMin: food.portionMin,
            portionMax: food.portionMax,
            unit: food.unit,
            recognitionConfidence: food.recognitionConfidence,
            portionConfidence: food.portionConfidence,
            uncertaintyReasons: food.uncertaintyReasons,
            preparationMethod: food.preparationMethod,
            visibleIngredients: food.visibleIngredients,
            notes: food.notes,
          };
        }),
      }),
    });

    if (!response.ok) return localMatches;
    const payload = (await response.json()) as NutritionResolveResponse;
    if (!Array.isArray(payload.matches)) return localMatches;

    const next = [...localMatches];
    payload.matches.forEach((match, offset) => {
      const index = unresolvedIndexes[offset];
      if (index === undefined) return;
      if (match.includedInTotal) next[index] = match;
    });
    return next;
  } catch {
    return localMatches;
  }
}
