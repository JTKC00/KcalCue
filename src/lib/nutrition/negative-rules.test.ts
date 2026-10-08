import { describe, expect, it } from "vitest";

import type { FoodEstimate } from "@/lib/domain/food-analysis";
import { canonicalizeFood, profileBlockedByNegativeRule } from "./canonical";
import { localNutritionProfiles } from "./local-data";
import { LocalNutritionProvider } from "./local-provider";
import { NEGATIVE_MATCH_RULES, SALAD_NAME_SPELLINGS, negativeRuleById } from "./negative-rules";

function food(
  displayName: string,
  normalizedName: string,
  identityLevel: FoodEstimate["identityLevel"] = "dish",
): FoodEstimate {
  return {
    displayName,
    normalizedName,
    identityLevel,
    portionMin: 100,
    portionMax: 100,
    unit: "g",
    recognitionConfidence: 0.9,
    portionConfidence: 0.8,
    uncertaintyReasons: [],
  };
}

const provider = new LocalNutritionProvider();

describe("negative match rules", () => {
  it("keeps the rules in one table", () => {
    expect(new Set(NEGATIVE_MATCH_RULES.map((rule) => rule.id)).size).toBe(NEGATIVE_MATCH_RULES.length);
    expect(SALAD_NAME_SPELLINGS).toEqual(["沙律", "沙拉"]);
    expect(negativeRuleById("plant-milk-not-whole-milk").blockProfileIds).toContain("whole-milk");
    expect(negativeRuleById("sesame-or-vinaigrette-not-lean-salad").patterns).toEqual(
      expect.arrayContaining(["胡麻醬", "油醋汁"]),
    );
    expect(negativeRuleById("creamy-dressing-not-lean-salad").patterns).toEqual(
      expect.arrayContaining(["千島醬", "凱撒", "蛋黃醬"]),
    );
    expect(negativeRuleById("composite-not-single-ingredient").kind).toBe("composite-not-ingredient");
  });

  it("keeps plant milks off whole milk", () => {
    for (const [displayName, normalizedName] of [
      ["豆漿", "soy milk"],
      ["燕麥奶", "oat milk"],
      ["杏仁奶", "almond milk"],
      ["椰奶", "coconut milk"],
    ] as const) {
      const match = provider.resolve(food(displayName, normalizedName, "ingredient"));
      expect(match.profile?.id, displayName).not.toBe("whole-milk");
      expect(match.includedInTotal, displayName).toBe(false);
      expect(canonicalizeFood(food(displayName, normalizedName, "ingredient")).canonicalName, displayName).not.toBe("milk");
    }
    expect(provider.resolve(food("牛奶", "whole milk", "ingredient")).profile?.id).toBe("whole-milk");
  });

  it("keeps chicken breast salad off the creamy profile", () => {
    for (const [displayName, normalizedName] of [
      ["雞胸沙拉", "雞胸沙拉"],
      ["雞胸沙律", "chicken breast salad"],
    ] as const) {
      const match = provider.resolve(food(displayName, normalizedName));
      expect(match.profile?.id, displayName).toBe("protein-vegetable-salad");
      expect(match.profile?.id, displayName).not.toBe("creamy-salad");
      expect(match.includedInTotal, displayName).toBe(true);
    }
  });

  it("routes named Chinese dressings away from the lean salad range", () => {
    for (const [displayName, normalizedName, profileId] of [
      ["千島醬沙律", "thousand island salad", "creamy-salad"],
      ["凱撒沙律", "caesar salad", "creamy-salad"],
      ["蛋黃醬沙律", "mayonnaise salad", "creamy-salad"],
    ] as const) {
      const match = provider.resolve(food(displayName, normalizedName));
      expect(match.profile?.id, displayName).toBe(profileId);
      expect(match.profile?.id, displayName).not.toBe("protein-vegetable-salad");
    }

    for (const [displayName, normalizedName] of [
      ["胡麻醬沙律", "sesame dressing salad"],
      ["油醋汁沙律", "vinaigrette salad"],
      ["雞胸胡麻醬沙律", "chicken breast sesame salad"],
      ["雞胸油醋汁沙律", "chicken breast vinaigrette salad"],
    ] as const) {
      const match = provider.resolve(food(displayName, normalizedName));
      expect(match.profile?.id, displayName).not.toBe("protein-vegetable-salad");
      expect(match.profile?.id, displayName).not.toBe("creamy-salad");
      expect(match.includedInTotal, displayName).toBe(false);
      expect(match.coverageReason, displayName).toBe("DISH_KNOWN_NO_PROFILE");
      expect(match.identity.dishId, displayName).toBe("dressed-salad");
    }
  });

  it("does not resolve a composite dish to a single ingredient profile", () => {
    const dish = food("叉燒飯", "char siu rice");
    const identity = canonicalizeFood(dish);
    const rice = localNutritionProfiles.find((profile) => profile.id === "white-rice-cooked");
    const pork = localNutritionProfiles.find((profile) => profile.id === "pork-cooked");
    expect(rice).toBeTruthy();
    expect(pork).toBeTruthy();
    if (!rice || !pork) return;
    expect(profileBlockedByNegativeRule(dish, identity, rice)).toBe(true);
    expect(profileBlockedByNegativeRule(dish, identity, pork)).toBe(true);

    const match = provider.resolve(dish);
    expect(match.profile?.composite).toBe(true);
    expect(match.profile?.id).not.toBe("white-rice-cooked");
    expect(match.profile?.id).not.toBe("pork-cooked");
  });
});
