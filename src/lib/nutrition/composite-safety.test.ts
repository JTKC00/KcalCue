import { describe, expect, it } from "vitest";

import type { FoodEstimate } from "@/lib/domain/food-analysis";
import {
  canonicalizeFood,
  isCompositeIdentity,
} from "./canonical";
import {
  foodIdentityLevel,
  isCompatibleNutritionIdentity,
  isGenericBaseIngredientProfile,
  profileIdentityLevel,
} from "./compatibility";
import { LocalNutritionProvider } from "./local-provider";
import { localNutritionProfiles } from "./local-data";
import { resolveNutritionMatch } from "./resolver";

function makeFood(
  displayName: string,
  normalizedName: string,
  overrides: Partial<FoodEstimate> = {},
): FoodEstimate {
  return {
    displayName,
    normalizedName,
    portionMin: 180,
    portionMax: 260,
    unit: "g",
    recognitionConfidence: 0.92,
    portionConfidence: 0.7,
    uncertaintyReasons: [],
    ...overrides,
  };
}

const provider = new LocalNutritionProvider();

const GENERIC_STARCH_PROTEIN_IDS = new Set([
  "white-rice-cooked",
  "rice-cooked-mixed",
  "egg-noodles-cooked",
  "bread-white",
  "beef-cooked",
  "pork-cooked",
  "chicken-breast-cooked",
  "chicken-thigh-grilled",
]);

describe("live composite regression", () => {
  it("does not treat squid-ink risotto as plain cooked white rice", () => {
    const food = makeFood("墨魚汁意大利飯", "squid ink risotto");
    const identity = canonicalizeFood(food);
    const match = provider.resolve(food);

    expect(isCompositeIdentity(identity)).toBe(true);
    expect(identity.qualifiers).toContain("composite");
    expect(identity.canonicalName).not.toBe("rice");
    expect(match.includedInTotal).toBe(false);
    expect(match.confidence).not.toBe("high");
    expect(match.confidence).not.toBe("medium");
    expect(match.matchType).toBe("unresolved");
    expect(match.profile?.id).not.toBe("white-rice-cooked");
    expect(match.profile?.canonicalName).not.toBe("rice");
    expect(match.reasons[0]).toContain("不足以代表整道菜");
  });
});

describe("simple base foods still resolve", () => {
  it.each([
    ["白飯", "cooked white rice", "rice", "white-rice-cooked"],
    ["白米飯", "white rice", "rice", "white-rice-cooked"],
    ["紅米飯", "cooked red rice", "rice", "rice-cooked-mixed"],
    ["糙米飯", "brown rice", "rice", "rice-cooked-mixed"],
    ["plain cooked rice", "plain cooked rice", "rice", "white-rice-cooked"],
    ["steamed rice", "steamed rice", "rice", "white-rice-cooked"],
    ["香蕉", "banana", "banana", "banana"],
    ["雞胸肉", "chicken breast", "chicken-breast", "chicken-breast-cooked"],
    ["三文魚", "salmon", "salmon", "salmon-cooked"],
    ["麵", "egg noodles", "noodles", "noodles-cooked"],
  ] as const)("%s stays a simple food match", (displayName, normalizedName, canonical, profileId) => {
    const food = makeFood(displayName, normalizedName, { portionMin: 100, portionMax: 150 });
    const identity = canonicalizeFood(food);
    const match = provider.resolve(food);

    expect(identity.canonicalName).toBe(canonical);
    expect(isCompositeIdentity(identity)).toBe(false);
    expect(match.includedInTotal).toBe(true);
    expect(["high", "medium"]).toContain(match.confidence);
    expect(match.profile?.id).toBe(profileId);
  });
});

describe("composite identity precedence", () => {
  it("ranks longer dish identities above short generic ingredients", () => {
    expect(canonicalizeFood(makeFood("墨魚汁意大利飯", "squid ink risotto"))).toMatchObject({
      canonicalName: "risotto",
      category: "mixed",
    });
    expect(canonicalizeFood(makeFood("牛肉燴飯", "beef braised rice"))).toMatchObject({
      canonicalName: "braised-rice",
      category: "mixed",
    });
    expect(canonicalizeFood(makeFood("芝士焗飯", "cheese baked rice"))).toMatchObject({
      canonicalName: "baked-rice",
      category: "mixed",
    });
    expect(canonicalizeFood(makeFood("海鮮炒飯", "seafood fried rice"))).toMatchObject({
      canonicalName: "fried-rice",
    });
    expect(canonicalizeFood(makeFood("咖喱雞飯", "curry chicken rice"))).toMatchObject({
      canonicalName: "curry",
    });
    expect(canonicalizeFood(makeFood("肉醬意粉", "spaghetti bolognese"))).toMatchObject({
      canonicalName: "bolognese",
    });
    expect(canonicalizeFood(makeFood("Carbonara", "carbonara"))).toMatchObject({
      canonicalName: "carbonara",
    });
    expect(canonicalizeFood(makeFood("炒麵", "fried noodles"))).toMatchObject({
      canonicalName: "fried-noodles",
    });
  });

  it("does not let protein or rice substrings steal a mixed dish", () => {
    const beefRice = canonicalizeFood(makeFood("牛肉燴飯", "beef braised rice"));
    expect(beefRice.canonicalName).not.toBe("beef");
    expect(beefRice.canonicalName).not.toBe("rice");
    expect(isCompositeIdentity(beefRice)).toBe(true);

    const mushroomRice = canonicalizeFood(makeFood("蘑菇飯", "mushroom rice"));
    expect(mushroomRice.canonicalName).not.toBe("rice");
    expect(isCompositeIdentity(mushroomRice)).toBe(true);
  });
});

describe("composite vocabulary without recipe aliases", () => {
  it.each([
    ["risotto", "risotto", "risotto"],
    ["意大利飯", "italian rice", "risotto"],
    ["燴飯", "braised rice", "braised-rice"],
    ["焗飯", "baked rice", "baked-rice"],
    ["炒飯", "fried rice", "fried-rice"],
    ["咖喱飯", "curry rice", "curry"],
    ["丼飯", "donburi", "donburi"],
    ["石鍋拌飯", "bibimbap", "bibimbap"],
    ["炒麵", "chow mein", "fried-noodles"],
    ["撈麵", "lo mein", "fried-noodles"],
    ["spaghetti", "spaghetti", "pasta"],
    ["ramen", "ramen", "ramen"],
    ["laksa", "laksa", "laksa"],
    ["pizza", "pizza", "pizza"],
    ["burrito", "burrito", "burrito"],
    ["三文治", "ham sandwich", "sandwich"],
  ] as const)("classifies %s as a dish, not a generic ingredient", (displayName, normalizedName, canonical) => {
    const identity = canonicalizeFood(makeFood(displayName, normalizedName));
    expect(identity.canonicalName).toBe(canonical);
    expect(isCompositeIdentity(identity)).toBe(true);
    expect(foodIdentityLevel(identity)).toBe("dish");
  });
});

describe("generic fallback safety gate", () => {
  it.each([
    ["墨魚汁意大利飯", "squid ink risotto"],
    ["咖喱雞飯", "curry chicken rice"],
    ["海鮮炒飯", "seafood fried rice"],
    ["芝士焗飯", "cheese baked rice"],
    ["牛肉燴飯", "beef braised rice"],
    ["Carbonara", "carbonara"],
    ["肉醬意粉", "spaghetti bolognese"],
    ["炒麵", "fried noodles"],
    ["Laksa", "laksa"],
    ["Pizza", "pizza"],
  ] as const)("does not include %s via a generic starch or protein profile", (displayName, normalizedName) => {
    const match = provider.resolve(makeFood(displayName, normalizedName));
    expect(match.includedInTotal).toBe(false);
    expect(["high", "medium"]).not.toContain(match.confidence);
    expect(match.profile?.id && GENERIC_STARCH_PROTEIN_IDS.has(match.profile.id)).toBeFalsy();
    if (match.profile) {
      expect(match.profile.composite).toBe(true);
      expect(isCompatibleNutritionIdentity(match.identity, match.profile)).toBe(true);
    }
  });

  it("rejects a composite identity against every generic catalog profile", () => {
    const identity = canonicalizeFood(makeFood("墨魚汁意大利飯", "squid ink risotto"));
    expect(identity.qualifiers).toContain("composite");

    for (const profile of localNutritionProfiles.filter((item) => !item.composite)) {
      expect(isGenericBaseIngredientProfile(profile)).toBe(true);
      expect(profileIdentityLevel(profile)).toBe("ingredient");
      expect(isCompatibleNutritionIdentity(identity, profile)).toBe(false);

      const match = resolveNutritionMatch(
        makeFood("墨魚汁意大利飯", "squid ink risotto"),
        [profile],
      );
      expect(match.includedInTotal).toBe(false);
      expect(match.matchType).toBe("unresolved");
    }
  });

  it("still allows a dedicated composite profile", () => {
    const dumpling = provider.resolve(makeFood("餃子", "dumpling", { unit: "piece", portionMin: 4, portionMax: 6 }));
    expect(dumpling.identity.qualifiers).toContain("composite");
    expect(dumpling.profile?.id).toBe("dumpling-cooked");
    expect(dumpling.includedInTotal).toBe(true);
    expect(dumpling.profile && isCompatibleNutritionIdentity(dumpling.identity, dumpling.profile)).toBe(true);
  });
});
