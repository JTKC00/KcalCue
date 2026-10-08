import type { FoodEstimate } from "@/lib/domain/food-analysis";

export type ResolvableFood = FoodEstimate & {
  entrySource?: "photo" | "manual";
  userMilkTypeChoice?: UserMilkTypeChoice;
  otherMilkNotice?: string;
};
import {
  canonicalizeFood,
  chocolateMilkName,
  contradictoryDairyMilkLabel,
  explicitLowFatMilk,
  isCompositeIdentity,
  normalizeFoodName,
  photoGenericMilkNeedsConfirmation,
  profileBlockedByNegativeRule,
  type MealPlantMilkContext,
} from "./canonical";
import {
  CHOCOLATE_MILK_UNCALCULATED_REASON,
  CREAM_MACARONI_UNCALCULATED_REASON,
  DRESSED_SALAD_UNCALCULATED_REASON,
  LOW_FAT_MILK_UNCALCULATED_REASON,
  PHOTO_GENERIC_MILK_CONFIRMATION_REASON,
  PHOTO_MILK_OTHER_REASON,
  PLANT_MILK_CONTRADICTION_REASON,
} from "./negative-rules";
import { milkResolveSubject, type UserMilkTypeChoice } from "./photo-milk";
import {
  COMPOSITE_GENERIC_FALLBACK_REASON,
  isCompatibleNutritionIdentity,
} from "./compatibility";
import {
  CHA_CHAAN_TENG_SET_UNCALCULATED_REASON,
  compositeDishCoverageReason,
} from "./coverage-reason";
import type {
  CanonicalFoodIdentity,
  FoodPreparation,
  NutritionConfidence,
  NutritionCoverageReason,
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

function isLowFatMilkProfile(profile: NutritionProfile): boolean {
  if (profile.id === "whole-milk") return false;
  const text = normalizeFoodName(namesOf(profile).join(" "));
  const lowFat = /低脂|脫脂|脱脂|low fat|reduced fat|skim/.test(text);
  return lowFat && /奶|milk/.test(text);
}

export function findLowFatMilkProfile(catalog: NutritionProfile[]): NutritionProfile | null {
  return catalog.find((profile) => isLowFatMilkProfile(profile)) ?? null;
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

  if (!isCompatibleNutritionIdentity(identity, profile)) score -= 200;
  else if (isCompositeIdentity(identity) && !profile.composite) score -= 40;
  else if (!isCompositeIdentity(identity) && profile.composite) score -= 20;

  return score;
}

function finishMatch(
  profile: NutritionProfile,
  matchType: NutritionMatchType,
  confidence: NutritionConfidence,
  reasons: string[],
): { matchType: NutritionMatchType; confidence: NutritionConfidence; reasons: string[] } {
  if (!profile.id.startsWith("template:")) return { matchType, confidence, reasons };
  const { min, max } = profile.nutrientsPer100g.calories;
  if (confidence === "high" && min > 0 && max / min >= 2) {
    reasons.push("食譜模板的熱量上限至少是下限的兩倍，因此信心維持中等。");
    return { matchType, confidence: "medium", reasons };
  }
  return { matchType, confidence, reasons };
}

function classifyMatch(
  identity: CanonicalFoodIdentity,
  profile: NutritionProfile,
  score: number,
  aliasExact: boolean,
): { matchType: NutritionMatchType; confidence: NutritionConfidence; reasons: string[] } {
  const reasons: string[] = [];

  // This band's max/min is about 4, so it stays medium. Other wide profiles keep their existing confidence.
  if (identity.canonicalName === "creamy-salad" && profile.canonicalName === "creamy-salad") {
    reasons.push("醬量、芝士或通粉份量未能由菜名確定，因此使用較寬範圍。");
    return {
      matchType: aliasExact ? "exact_canonical" : "strong_synonym",
      confidence: "medium",
      reasons,
    };
  }

  if (aliasExact && identity.canonicalName === profile.canonicalName) {
    reasons.push("名稱與參考資料的標準名稱一致。");
    if (
      identity.preparation === "unknown" ||
      preparationCompatible(identity, profile)
    ) {
      return finishMatch(profile, "exact_canonical", "high", reasons);
    }
    reasons.push("烹調方法未能完全對應，密度範圍已保留不確定性。");
    return finishMatch(profile, "exact_canonical", "medium", reasons);
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
      return finishMatch(profile, "exact_canonical", "medium", reasons);
    }
    return finishMatch(
      profile,
      aliasExact ? "exact_canonical" : "strong_synonym",
      "high",
      reasons,
    );
  }

  if (isCompositeIdentity(identity) || !isCompatibleNutritionIdentity(identity, profile)) {
    reasons.push(compositeUnmatchedReason(identity));
    return { matchType: "unresolved", confidence: "low", reasons };
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

function unmatched(
  match: Omit<NutritionMatch, "coverageReason" | "includedInTotal">,
  coverageReason: NutritionCoverageReason,
): NutritionMatch {
  return { ...match, includedInTotal: false, coverageReason };
}

function compositeUnmatchedReason(identity: CanonicalFoodIdentity): string {
  if (identity.canonicalName === "dressed-salad" || identity.dishId === "dressed-salad") {
    return DRESSED_SALAD_UNCALCULATED_REASON;
  }
  if (identity.canonicalName === "cream-macaroni" || identity.dishId === "cream-macaroni") {
    return CREAM_MACARONI_UNCALCULATED_REASON;
  }
  if (identity.dishId === "cha-chaan-teng-set") return CHA_CHAAN_TENG_SET_UNCALCULATED_REASON;
  return COMPOSITE_GENERIC_FALLBACK_REASON;
}

export function resolveNutritionMatch(
  food: ResolvableFood,
  catalog: NutritionProfile[],
  mealContext?: MealPlantMilkContext,
): NutritionMatch {
  if (
    food.userMilkTypeChoice === "other" ||
    food.otherMilkNotice === PHOTO_MILK_OTHER_REASON ||
    food.uncertaintyReasons.includes(PHOTO_MILK_OTHER_REASON)
  ) {
    return unmatched({
      profile: null,
      confidence: "low",
      matchType: "unresolved",
      reasons: [PHOTO_MILK_OTHER_REASON],
      identity: canonicalizeFood(food),
    }, "INSUFFICIENT_COVERAGE");
  }
  const subject = milkResolveSubject(food);
  const explicitChoice = food.userMilkTypeChoice != null;
  const identity = canonicalizeFood(subject);
  if (!explicitChoice && contradictoryDairyMilkLabel(food, mealContext)) {
    return unmatched({
      profile: null,
      confidence: "low",
      matchType: "unresolved",
      reasons: [PLANT_MILK_CONTRADICTION_REASON],
      identity,
    }, "INSUFFICIENT_COVERAGE");
  }
  if (chocolateMilkName(subject)) {
    return unmatched({
      profile: null,
      confidence: "low",
      matchType: "unresolved",
      reasons: [CHOCOLATE_MILK_UNCALCULATED_REASON],
      identity,
    }, "INSUFFICIENT_COVERAGE");
  }
  if (explicitLowFatMilk(subject)) {
    const lowFatProfile = findLowFatMilkProfile(catalog);
    if (!lowFatProfile) {
      return unmatched({
        profile: null,
        confidence: "low",
        matchType: "unresolved",
        reasons: [LOW_FAT_MILK_UNCALCULATED_REASON],
        identity,
      }, "INSUFFICIENT_COVERAGE");
    }
    const gramsPerUnit = lowFatProfile.gramsPerUnit[subject.unit];
    if (typeof gramsPerUnit !== "number" || !Number.isFinite(gramsPerUnit) || gramsPerUnit <= 0) {
      return unmatched({
        profile: null,
        confidence: "low",
        matchType: "unresolved",
        reasons: [`未有 ${subject.unit} 的可靠克重換算，因此不納入總數。`],
        identity,
      }, "UNIT_CONVERSION_MISSING");
    }
    return {
      profile: lowFatProfile,
      confidence: "high",
      matchType: "exact_canonical",
      reasons: ["名稱對應目錄中的低脂或減脂奶。"],
      identity,
      includedInTotal: true,
    };
  }
  if (photoGenericMilkNeedsConfirmation(subject, mealContext)) {
    return unmatched({
      profile: null,
      confidence: "low",
      matchType: "unresolved",
      reasons: [PHOTO_GENERIC_MILK_CONFIRMATION_REASON],
      identity,
    }, "AMBIGUOUS_MATCH");
  }
  if (identity.qualifiers.includes("ambiguous")) {
    return unmatched({
      profile: null,
      confidence: "low",
      matchType: "unresolved",
      reasons: ["找到多個相近但不相同的營養資料，為免假裝精準，暫不自動配對。"],
      identity,
    }, "AMBIGUOUS_MATCH");
  }

  const eligibleCatalog = catalog.filter(
    (profile) => !profileBlockedByNegativeRule(subject, identity, profile),
  );
  const ranked = eligibleCatalog
    .map((profile) => ({
      profile,
      score: scoreProfile(subject, identity, profile),
      aliasExact:
        exactAliasHit(subject.normalizedName, profile) ||
        exactAliasHit(subject.displayName, profile),
    }))
    .sort((left, right) => right.score - left.score);

  const compatible = ranked.filter((item) =>
    isCompatibleNutritionIdentity(identity, item.profile),
  );
  const best = isCompositeIdentity(identity) ? compatible[0] : ranked[0];
  const second = isCompositeIdentity(identity) ? compatible[1] : ranked[1];

  if (isCompositeIdentity(identity) && (!best || best.score < 50)) {
    return unmatched({
      profile: null,
      confidence: "low",
      matchType: "unresolved",
      reasons: [compositeUnmatchedReason(identity)],
      identity,
    }, compositeDishCoverageReason(identity));
  }

  if (!best || best.score < 50) {
    return unmatched({
      profile: null,
      confidence: "low",
      matchType: "unresolved",
      reasons: ["未有足夠可靠的營養參考資料可以配對。"],
      identity,
    }, isCompositeIdentity(identity)
      ? compositeDishCoverageReason(identity)
      : "INSUFFICIENT_COVERAGE");
  }

  if (second && best.score - second.score < 12 && best.profile.canonicalName !== second.profile.canonicalName) {
    return unmatched({
      profile: null,
      confidence: "low",
      matchType: "unresolved",
      reasons: ["找到多個相近但不相同的營養資料，為免假裝精準，暫不自動配對。"],
      identity,
    }, "AMBIGUOUS_MATCH");
  }

  const gramsPerUnit = best.profile.gramsPerUnit[subject.unit];
  if (typeof gramsPerUnit !== "number" || !Number.isFinite(gramsPerUnit) || gramsPerUnit <= 0) {
    return unmatched({
      profile: null,
      confidence: "low",
      matchType: "unresolved",
      reasons: [`未有 ${subject.unit} 的可靠克重換算，因此不納入總數。`],
      identity,
    }, "UNIT_CONVERSION_MISSING");
  }

  const classified = classifyMatch(identity, best.profile, best.score, best.aliasExact);
  const includedInTotal =
    classified.matchType !== "unresolved" &&
    INCLUDED_NUTRITION_CONFIDENCE.includes(classified.confidence) &&
    !(isCompositeIdentity(identity) && classified.confidence === "low");

  if (!includedInTotal && classified.matchType === "approximate_generic") {
    return unmatched({
      profile: best.profile,
      confidence: "low",
      matchType: "approximate_generic",
      reasons: classified.reasons,
      identity,
    }, "INSUFFICIENT_COVERAGE");
  }

  if (!includedInTotal) {
    // TYPE_MISMATCH is a dish/ingredient level conflict. Missing gram factors
    // are UNIT_CONVERSION_MISSING, decided before classify.
    const coverageReason: NutritionCoverageReason = classified.matchType !== "unresolved"
      ? "INSUFFICIENT_COVERAGE"
      : !isCompatibleNutritionIdentity(identity, best.profile)
        ? "TYPE_MISMATCH"
        : isCompositeIdentity(identity)
          ? compositeDishCoverageReason(identity)
          : "INSUFFICIENT_COVERAGE";
    return unmatched({
      profile: null,
      confidence: classified.confidence,
      matchType: "unresolved",
      reasons: classified.reasons,
      identity,
    }, coverageReason);
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
