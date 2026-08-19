import type { FoodEstimate } from "@/lib/domain/food-analysis";
import {
  canonicalizeFood,
  isCompositeIdentity,
  normalizeFoodName,
} from "./canonical";
import type {
  CanonicalFoodIdentity,
  FoodPreparation,
  NutritionConfidence,
  NutritionMatch,
  NutritionMatchType,
  NutritionProfile,
} from "./types";
import { INCLUDED_NUTRITION_CONFIDENCE } from "./types";

const PREPARATION_FAMILY: Record<FoodPreparation, FoodPreparation[]> = {
  raw: ["raw"],
  cooked: ["cooked", "steamed", "boiled", "grilled", "pan_fried", "stir_fried"],
  steamed: ["steamed", "boiled", "cooked"],
  boiled: ["boiled", "steamed", "cooked"],
  pan_fried: ["pan_fried", "grilled", "cooked"],
  grilled: ["grilled", "pan_fried", "cooked"],
  stir_fried: ["stir_fried", "cooked"],
  deep_fried: ["deep_fried"],
  sauced: ["sauced", "cooked"],
  unknown: ["cooked", "unknown"],
};

function namesOf(profile: NutritionProfile): string[] {
  return [profile.id, profile.displayName, profile.canonicalName, ...profile.aliases];
}

function exactAliasHit(name: string, profile: NutritionProfile): boolean {
  const normalized = normalizeFoodName(name);
  if (!normalized) return false;
  return namesOf(profile).some((alias) => normalizeFoodName(alias) === normalized);
}

function preparationCompatible(
  identity: CanonicalFoodIdentity,
  profile: NutritionProfile,
): boolean {
  if (identity.preparation === "unknown") return true;
  return profile.preparations.some((prep) =>
    PREPARATION_FAMILY[identity.preparation].includes(prep),
  );
}

function scoreProfile(
  food: FoodEstimate,
  identity: CanonicalFoodIdentity,
  profile: NutritionProfile,
): number {
  let score = 0;

  if (
    exactAliasHit(food.normalizedName, profile) ||
    exactAliasHit(food.displayName, profile)
  ) {
    score += 120;
  }

  if (identity.canonicalName !== "unknown" && identity.canonicalName === profile.canonicalName) {
    score += 100;
  } else if (
    identity.canonicalName === "chicken" &&
    (profile.canonicalName === "chicken-breast" ||
      profile.canonicalName === "chicken-thigh" ||
      profile.canonicalName === "chicken")
  ) {
    score += 55;
  } else if (
    identity.canonicalName === "vegetables" &&
    (profile.canonicalName === "leafy-greens" ||
      profile.canonicalName === "mixed-vegetables" ||
      profile.canonicalName === "vegetables")
  ) {
    score += 55;
  } else if (
    identity.canonicalName === "tomato" &&
    profile.canonicalName === "tomato-sauce"
  ) {
    score += 80;
  }

  if (identity.category === profile.category) score += 30;

  if (preparationCompatible(identity, profile)) score += 20;
  else score -= 15;

  if (
    identity.qualifiers.includes("wholegrain") &&
    profile.canonicalName === "rice" &&
    profile.id.includes("mixed")
  ) {
    score += 25;
  }

  if (identity.qualifiers.includes("tomato") && profile.canonicalName === "tomato-sauce") {
    score += 25;
  }

  if (identity.qualifiers.includes("mixed") && profile.canonicalName === "mixed-vegetables") {
    score += 20;
  }

  if (isCompositeIdentity(identity) && !profile.composite) score -= 40;
  if (!isCompositeIdentity(identity) && profile.composite) score -= 20;

  return score;
}

function classifyMatch(
  identity: CanonicalFoodIdentity,
  profile: NutritionProfile,
  score: number,
  aliasExact: boolean,
): { matchType: NutritionMatchType; confidence: NutritionConfidence; reasons: string[] } {
  const reasons: string[] = [];

  if (aliasExact && identity.canonicalName === profile.canonicalName) {
    reasons.push("名稱與參考資料的標準名稱一致。");
    if (
      identity.preparation === "unknown" ||
      preparationCompatible(identity, profile)
    ) {
      return { matchType: "exact_canonical", confidence: "high", reasons };
    }
    reasons.push("烹調方法未能完全對應，密度範圍已保留不確定性。");
    return { matchType: "exact_canonical", confidence: "medium", reasons };
  }

  if (identity.canonicalName === profile.canonicalName) {
    reasons.push("已對應到同一類標準食物，而不是只靠顯示名稱。");
    if (
      identity.preparation !== "unknown" &&
      !preparationCompatible(identity, profile)
    ) {
      reasons.push("烹調方法與參考資料不完全相同。");
      return { matchType: "strong_synonym", confidence: "medium", reasons };
    }
    if (identity.qualifiers.includes("wholegrain") || identity.preparation === "pan_fried") {
      reasons.push("品種或用油未能由相片確定，因此營養密度使用範圍。");
      return { matchType: "exact_canonical", confidence: "medium", reasons };
    }
    return {
      matchType: aliasExact ? "exact_canonical" : "strong_synonym",
      confidence: "high",
      reasons,
    };
  }

  if (identity.category === profile.category && score >= 70) {
    reasons.push("以食物類別及烹調方式配對通用參考資料。");
    return { matchType: "category_preparation", confidence: "medium", reasons };
  }

  if (score >= 50) {
    reasons.push("只找到較粗略的同類食物資料，差異可能較大。");
    return { matchType: "approximate_generic", confidence: "low", reasons };
  }

  return {
    matchType: "unresolved",
    confidence: "low",
    reasons: ["未有足夠可靠的營養參考資料可以配對。"],
  };
}

export function resolveNutritionMatch(
  food: FoodEstimate,
  catalog: NutritionProfile[],
): NutritionMatch {
  const identity = canonicalizeFood(food);
  const ranked = catalog
    .map((profile) => ({
      profile,
      score: scoreProfile(food, identity, profile),
      aliasExact:
        exactAliasHit(food.normalizedName, profile) ||
        exactAliasHit(food.displayName, profile),
    }))
    .sort((left, right) => right.score - left.score);

  const best = ranked[0];
  const second = ranked[1];

  if (
    !best ||
    best.score < 50 ||
    (isCompositeIdentity(identity) &&
      best.profile.canonicalName !== identity.canonicalName)
  ) {
    return {
      profile: null,
      confidence: "low",
      matchType: "unresolved",
      reasons: isCompositeIdentity(identity)
        ? ["這類組合菜式變化太大，現有資料不足以代表實際食材與烹調。"]
        : ["未有足夠可靠的營養參考資料可以配對。"],
      identity,
      includedInTotal: false,
    };
  }

  if (second && best.score - second.score < 12 && best.profile.canonicalName !== second.profile.canonicalName) {
    return {
      profile: null,
      confidence: "low",
      matchType: "unresolved",
      reasons: ["找到多個相近但不相同的營養資料，為免假裝精準，暫不自動配對。"],
      identity,
      includedInTotal: false,
    };
  }

  const classified = classifyMatch(identity, best.profile, best.score, best.aliasExact);
  const includedInTotal =
    classified.matchType !== "unresolved" &&
    INCLUDED_NUTRITION_CONFIDENCE.includes(classified.confidence) &&
    !(isCompositeIdentity(identity) && classified.confidence === "low");

  if (!includedInTotal && classified.matchType === "approximate_generic") {
    return {
      profile: best.profile,
      confidence: "low",
      matchType: "approximate_generic",
      reasons: classified.reasons,
      identity,
      includedInTotal: false,
    };
  }

  if (!includedInTotal) {
    return {
      profile: null,
      confidence: classified.confidence,
      matchType: "unresolved",
      reasons: classified.reasons,
      identity,
      includedInTotal: false,
    };
  }

  return {
    profile: best.profile,
    confidence: classified.confidence,
    matchType: classified.matchType,
    reasons: classified.reasons,
    identity,
    includedInTotal: true,
  };
}

export function findProfileByNormalizedName(
  name: string,
  catalog: NutritionProfile[],
): NutritionProfile | null {
  const normalized = normalizeFoodName(name);
  if (!normalized) return null;
  return (
    catalog.find((profile) =>
      namesOf(profile).some((alias) => normalizeFoodName(alias) === normalized),
    ) ?? null
  );
}
