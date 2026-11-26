import type { FoodEstimate } from "@/lib/domain/food-analysis";
import type { ResolvableFood } from "./resolver";
import {
  canonicalizeFood,
  contradictoryDairyMilkLabel,
  normalizeFoodName,
  photoGenericMilkNeedsConfirmation,
  type MealPlantMilkContext,
} from "./canonical";
import { CATALOG_PROFILE_ID_PREFIX } from "./catalog-entry";
import type { NutritionMatch } from "./types";
import { copy } from "@/content/zh-HK";
import { nutritionMatchResponseSchema } from "./response-schema";

const BARCODE_CUE_RE = /(?:^|[^0-9])\d{8,14}(?:$|[^0-9])/;

export function isExactLocalProfileMatch(
  food: Pick<FoodEstimate, "displayName" | "normalizedName">,
  match: NutritionMatch | null | undefined,
): boolean {
  if (!match?.includedInTotal || !match.profile) return false;
  const names = [
    match.profile.id,
    match.profile.displayName,
    match.profile.canonicalName,
    ...match.profile.aliases,
  ].map(normalizeFoodName);
  const display = normalizeFoodName(food.displayName);
  const normalized = normalizeFoodName(food.normalizedName);
  if (display) return names.includes(display);
  return Boolean(normalized) && names.includes(normalized);
}

function hasServerCatalogContextCue(
  food: Pick<ResolvableFood, "displayName" | "normalizedName" | "notes">,
): boolean {
  if (food.notes?.trim()) return true;
  if (BARCODE_CUE_RE.test(food.displayName) || BARCODE_CUE_RE.test(food.normalizedName)) return true;
  return false;
}

export function needsServerCatalogCheck(
  food: ResolvableFood,
  localMatch: NutritionMatch | null | undefined,
  mealContext?: MealPlantMilkContext,
): boolean {
  if (food.suspectedDuplicateMilk === true) return false;
  if (food.userMilkTypeChoice != null) return false;
  if (contradictoryDairyMilkLabel(food, mealContext)) return false;
  if (photoGenericMilkNeedsConfirmation(food, mealContext)) return false;
  if (
    localMatch?.includedInTotal &&
    (localMatch.profile?.source.provider === "usda-fdc" ||
      localMatch.profile?.id.startsWith(CATALOG_PROFILE_ID_PREFIX))
  ) {
    return false;
  }
  if (!localMatch || !localMatch.includedInTotal) return true;
  if (!isExactLocalProfileMatch(food, localMatch)) return true;
  return hasServerCatalogContextCue(food);
}

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

  // An unchanged name cannot preserve a match whose density cannot express
  // the edited unit. The persisted includedInTotal flag must agree with the
  // value that calculateFoodNutrition can actually include.
  const currentFactor = match.profile.gramsPerUnit[currentFood.unit];
  const nextFactor = match.profile.gramsPerUnit[nextFood.unit];
  if (
    typeof currentFactor !== "number" || !Number.isFinite(currentFactor) || currentFactor <= 0 ||
    typeof nextFactor !== "number" || !Number.isFinite(nextFactor) || nextFactor <= 0
  ) return false;

  // Catalog matches can depend on item notes (brand/barcode) or piece count semantics
  // (e.g. 1 box of 6pc McNuggets vs 6 individual pieces). Re-resolve when those change.
  if (match.profile.id.startsWith(CATALOG_PROFILE_ID_PREFIX)) {
    if ((currentFood.notes ?? "").trim() !== (nextFood.notes ?? "").trim()) return false;
    if (
      currentFood.unit === "piece" &&
      nextFood.unit === "piece" &&
      (currentFood.portionMax > 1) !== (nextFood.portionMax > 1)
    ) {
      return false;
    }
  }

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
  foods: ResolvableFood[],
  localMatches: NutritionMatch[],
  signal?: AbortSignal,
  mealContext?: MealPlantMilkContext,
): Promise<NutritionMatch[]> {
  const unresolvedIndexes = localMatches
    .map((match, index) => (
      foods[index] && needsServerCatalogCheck(foods[index], match, mealContext)
        ? index
        : -1
    ))
    .filter((index) => index >= 0);

  if (unresolvedIndexes.length === 0) return localMatches;

  const failedMatch = (match: NutritionMatch): NutritionMatch => signal?.aborted || match.includedInTotal
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
        ...(mealContext ? { mealContext } : {}),
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
            ...(food.entrySource ? { entrySource: food.entrySource } : {}),
            ...(food.userMilkTypeChoice ? { userMilkTypeChoice: food.userMilkTypeChoice } : {}),
            ...(food.otherMilkNotice ? { otherMilkNotice: food.otherMilkNotice } : {}),
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
      if (match.includedInTotal) {
        next[index] = match;
      } else if (!localMatches[index].includedInTotal && warningIndexes.has(offset)) {
        next[index] = failedMatch(localMatches[index]);
      } else if (
        !localMatches[index].includedInTotal &&
        (match.coverageReason === "UNIT_CONVERSION_MISSING" || match.coverageReason === "AMBIGUOUS_MATCH")
      ) {
        next[index] = match;
      }
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
  mealContext?: MealPlantMilkContext,
): Promise<NutritionMatch> {
  const [match] = await enrichUnresolvedMatches([food], [localMatch], signal, mealContext);
  return match ?? localMatch;
}
