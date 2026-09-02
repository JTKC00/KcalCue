import type { FoodEstimate } from "@/lib/domain/food-analysis";
import { canonicalizeFood, normalizeFoodName } from "./canonical";
import type { NutritionMatch } from "./types";

export interface NutritionResolveResponse {
  matches?: NutritionMatch[];
  provider?: string;
  error?: { code?: string };
  warnings?: Array<{ index?: number; code?: string }>;
}

function nutritionIdentityKey(
  identity: NutritionMatch["identity"],
): string {
  return [
    identity.canonicalName,
    identity.category,
    identity.preparation,
    [...identity.qualifiers].sort().join(","),
  ].join("|");
}

export function canReuseNutritionMatchForNameEdit(
  currentFood: FoodEstimate,
  nextFood: FoodEstimate,
  match: NutritionMatch | null | undefined,
): match is NutritionMatch {
  if (!match?.profile) return false;

  const currentIdentity = canonicalizeFood(currentFood);
  const nextIdentity = canonicalizeFood(nextFood);
  const matchIdentityKey = nutritionIdentityKey(match.identity);
  if (
    nutritionIdentityKey(currentIdentity) !== matchIdentityKey ||
    nutritionIdentityKey(nextIdentity) !== matchIdentityKey
  ) {
    return false;
  }

  return (
    normalizeFoodName(currentFood.normalizedName || currentFood.displayName) ===
    normalizeFoodName(nextFood.normalizedName || nextFood.displayName)
  );
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
            identityLevel: food.identityLevel,
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

export async function resolveNutritionMatchWithFallback(
  food: FoodEstimate,
  localMatch: NutritionMatch,
): Promise<NutritionMatch> {
  const [match] = await enrichUnresolvedMatches([food], [localMatch]);
  return match ?? localMatch;
}
