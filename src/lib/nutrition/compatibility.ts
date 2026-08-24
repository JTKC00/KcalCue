import { isCompositeIdentity } from "./canonical";
import type { CanonicalFoodIdentity, NutritionProfile } from "./types";

export type FoodIdentityLevel = "dish" | "ingredient";

export const COMPOSITE_GENERIC_FALLBACK_REASON =
  "找到相近的基礎食材資料，但不足以代表整道菜，因此未納入總數。";

export function foodIdentityLevel(
  identity: CanonicalFoodIdentity,
): FoodIdentityLevel {
  return isCompositeIdentity(identity) ? "dish" : "ingredient";
}

export function profileIdentityLevel(
  profile: NutritionProfile,
): FoodIdentityLevel {
  return profile.composite ? "dish" : "ingredient";
}

export function isGenericBaseIngredientProfile(
  profile: NutritionProfile,
): boolean {
  return !profile.composite;
}

export function isCompatibleNutritionIdentity(
  identity: CanonicalFoodIdentity,
  profile: NutritionProfile,
): boolean {
  const foodLevel = foodIdentityLevel(identity);
  const nutritionLevel = profileIdentityLevel(profile);

  if (foodLevel === "dish" && nutritionLevel === "ingredient") return false;
  if (foodLevel === "ingredient" && nutritionLevel === "dish") return false;
  if (foodLevel === "dish" && nutritionLevel === "dish") {
    return identity.canonicalName === profile.canonicalName;
  }

  return true;
}
