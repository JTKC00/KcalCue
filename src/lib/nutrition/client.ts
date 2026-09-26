import type { FoodEstimate } from "@/lib/domain/food-analysis";
import { canonicalizeFood, normalizeFoodName } from "./canonical";
import type { NutritionMatch } from "./types";
import { copy } from "@/content/zh-HK";
import { nutritionMatchResponseSchema } from "./response-schema";

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
  signal?: AbortSignal,
): Promise<NutritionMatch[]> {
  const unresolvedIndexes = localMatches
    .map((match, index) => (match.includedInTotal ? -1 : index))
    .filter((index) => index >= 0);

  if (unresolvedIndexes.length === 0) return localMatches;

  const failedMatch = (match: NutritionMatch): NutritionMatch => signal?.aborted
    ? match
    : {
      ...match,
      reasons: [copy.nutritionLookupFailed, ...match.reasons.filter(reason => reason !== copy.nutritionLookupFailed)],
    };
  const failedLookup = () => localMatches.map((match, index) =>
    unresolvedIndexes.includes(index) ? failedMatch(match) : match,
  );

  try {
    const { authorizedFetch } = await import("@/lib/firebase/client");
    const response = await authorizedFetch("/api/nutrition/resolve", {
      signal,
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

    if (!response.ok) return failedLookup();
    const payload = (await response.json()) as NutritionResolveResponse;
    if (!Array.isArray(payload.matches)) return failedLookup();

    const next = [...localMatches];
    const warningIndexes = new Set(Array.isArray(payload.warnings)
      ? payload.warnings.map(warning => warning?.index)
      : []);
    unresolvedIndexes.forEach((index, offset) => {
      const parsed = nutritionMatchResponseSchema.safeParse(payload.matches?.[offset]);
      if (!parsed.success) {
        next[index] = failedMatch(localMatches[index]);
        return;
      }
      const match = parsed.data;
      if (match.includedInTotal) next[index] = match;
      else if (warningIndexes.has(offset)) next[index] = failedMatch(localMatches[index]);
    });
    return next;
  } catch {
    return failedLookup();
  }
}

export async function resolveNutritionMatchWithFallback(
  food: FoodEstimate,
  localMatch: NutritionMatch,
  signal?: AbortSignal,
): Promise<NutritionMatch> {
  const [match] = await enrichUnresolvedMatches([food], [localMatch], signal);
  return match ?? localMatch;
}
