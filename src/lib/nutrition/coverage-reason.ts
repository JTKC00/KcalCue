import type { CanonicalFoodIdentity, NutritionCoverageReason } from "./types";

export const NUTRITION_COVERAGE_REASONS = [
  "UNKNOWN_DISH",
  "DISH_KNOWN_NO_PROFILE",
  "COMPOSITE_UNSUPPORTED",
  "TYPE_MISMATCH",
  "UNIT_CONVERSION_MISSING",
  "AMBIGUOUS_MATCH",
  "INSUFFICIENT_COVERAGE",
] as const satisfies readonly NutritionCoverageReason[];

/**
 * Dish identities synthesized when the name is not a specific catalogued dish.
 * These are "we do not know which dish this is", not "we named the dish and
 * still have no whole-dish profile".
 */
const GENERIC_DISH_CANONICALS = new Set([
  "unknown",
  "mixed-dish",
  "rice-dish",
  "noodle-dish",
  "bread-dish",
]);

export function compositeDishCoverageReason(
  identity: CanonicalFoodIdentity,
): NutritionCoverageReason {
  if (identity.dishId && identity.hasNutritionProfile === false) return "DISH_KNOWN_NO_PROFILE";
  if (GENERIC_DISH_CANONICALS.has(identity.canonicalName)) return "UNKNOWN_DISH";
  return "COMPOSITE_UNSUPPORTED";
}
