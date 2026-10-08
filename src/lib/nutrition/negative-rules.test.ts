import { describe, expect, it } from "vitest";

import type { FoodEstimate } from "@/lib/domain/food-analysis";
import { canonicalizeFood, contradictoryDairyMilkLabel, isCompositeIdentity, profileBlockedByNegativeRule } from "./canonical";
import { localNutritionProfiles } from "./local-data";
import { LocalNutritionProvider } from "./local-provider";
import {
  DRESSED_SALAD_UNCALCULATED_REASON,
  NEGATIVE_MATCH_RULES,
  PLANT_MILK_CONTRADICTION_REASON,
  SALAD_NAME_SPELLINGS,
  negativeRuleById,
} from "./negative-rules";

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
      expect(match.reasons[0], displayName).toBe(DRESSED_SALAD_UNCALCULATED_REASON);
    }

    const englishOnly = provider.resolve(food("sesame dressing salad", "vinaigrette salad"));
    expect(englishOnly.includedInTotal).toBe(false);
    expect(englishOnly.coverageReason).toBe("DISH_KNOWN_NO_PROFILE");
    expect(englishOnly.reasons[0]).toBe(DRESSED_SALAD_UNCALCULATED_REASON);
  });

  it("does not treat dairy milk as whole milk when the description says plant milk", () => {
    const plain = food("牛奶", "whole milk", "ingredient");
    expect(contradictoryDairyMilkLabel(plain)).toBe(false);
    expect(provider.resolve(plain).profile?.id).toBe("whole-milk");

    const cases = [
      food("牛奶", "milk", "ingredient"),
      food("牛奶", "whole milk", "ingredient"),
      food("全脂奶", "milk", "ingredient"),
    ];
    cases[0] = { ...cases[0], notes: "oat milk in a glass" };
    cases[1] = { ...cases[1], visibleIngredients: ["oats"] };
    cases[2] = { ...cases[2], uncertaintyReasons: ["可能是杏仁奶"] };

    for (const item of cases) {
      expect(contradictoryDairyMilkLabel(item), item.displayName).toBe(true);
      const match = provider.resolve(item);
      expect(match.profile?.id, item.displayName).not.toBe("whole-milk");
      expect(match.includedInTotal, item.displayName).toBe(false);
      expect(match.coverageReason, item.displayName).toBe("INSUFFICIENT_COVERAGE");
      expect(match.reasons[0], item.displayName).toBe(PLANT_MILK_CONTRADICTION_REASON);
      expect(canonicalizeFood(item).canonicalName, item.displayName).not.toBe("milk");
    }

    const namedOat = food("燕麥奶", "oat milk", "ingredient");
    expect(contradictoryDairyMilkLabel(namedOat)).toBe(false);
    expect(provider.resolve(namedOat).profile?.id).not.toBe("whole-milk");

    const evidenceOnly = food("牛奶", "milk", "ingredient");
    expect(contradictoryDairyMilkLabel(evidenceOnly)).toBe(false);
    expect(provider.resolve(evidenceOnly).profile?.id).toBe("whole-milk");
  });

  it("blocks fresh, skim, and low-fat dairy labels before a USDA live lookup", () => {
    const reachesUsdaLive = (item: FoodEstimate) => {
      const match = provider.resolve(item);
      return !match.includedInTotal
        && item.unit === "g"
        && !isCompositeIdentity(match.identity)
        && !contradictoryDairyMilkLabel(item);
    };

    for (const item of [
      food("鮮奶", "鮮奶", "ingredient"),
      food("鮮奶", "fresh milk", "ingredient"),
    ]) {
      expect(contradictoryDairyMilkLabel(item), item.normalizedName).toBe(false);
      expect(provider.resolve(item).profile?.id, item.normalizedName).toBe("whole-milk");
      expect(provider.resolve(item).includedInTotal, item.normalizedName).toBe(true);
      expect(reachesUsdaLive(item), item.normalizedName).toBe(false);
    }

    const lowFat = food("低脂奶", "低脂奶", "ingredient");
    expect(contradictoryDairyMilkLabel(lowFat)).toBe(false);
    expect(provider.resolve(lowFat).profile?.id).not.toBe("whole-milk");
    expect(reachesUsdaLive(lowFat)).toBe(true);

    const freshButLowFat = { ...food("鮮奶", "fresh milk", "ingredient"), notes: "低脂" };
    expect(contradictoryDairyMilkLabel(freshButLowFat)).toBe(false);
    expect(provider.resolve(freshButLowFat).profile?.id).not.toBe("whole-milk");
    expect(reachesUsdaLive(freshButLowFat)).toBe(true);

    const guarded = [
      food("鮮奶", "fresh milk", "ingredient"),
      food("低脂奶", "low-fat milk", "ingredient"),
      food("鮮奶", "skim milk", "ingredient"),
      food("低脂奶", "semi-skimmed milk", "ingredient"),
    ];
    guarded[0] = { ...guarded[0], notes: "oat" };
    guarded[1] = { ...guarded[1], visibleIngredients: ["soy milk"] };
    guarded[2] = { ...guarded[2], uncertaintyReasons: ["杏仁奶"] };
    guarded[3] = { ...guarded[3], preparationMethod: "植物奶" };

    const notMilkDrinks = [
      food("牛奶布甸", "milk pudding", "dish"),
      food("奶茶", "milk tea", "dish"),
      food("港式奶茶", "hong kong milk tea", "dish"),
      food("牛奶麥片", "cereal with milk", "dish"),
      food("牛奶麥片", "cereal with milk", "ingredient"),
    ];
    for (const item of notMilkDrinks) {
      const withSlices = {
        ...item,
        visibleIngredients: ["杏仁片", "黃豆"],
      };
      expect(contradictoryDairyMilkLabel(withSlices), item.displayName).toBe(false);
      const match = provider.resolve(withSlices);
      expect(match.reasons[0], item.displayName).not.toBe(PLANT_MILK_CONTRADICTION_REASON);
      expect(match.coverageReason, item.displayName).not.toBe("INSUFFICIENT_COVERAGE");
    }
    const pudding = provider.resolve({
      ...food("牛奶布甸", "milk pudding", "dish"),
      visibleIngredients: ["杏仁片", "黃豆"],
    });
    expect(pudding.profile?.id).not.toBe("whole-milk");
    const tea = provider.resolve({
      ...food("奶茶", "milk tea", "dish"),
      visibleIngredients: ["杏仁片", "黃豆"],
    });
    expect(tea.profile?.id).toBe("milk-tea");
    expect(tea.includedInTotal).toBe(true);
    for (const identityLevel of ["dish", "ingredient"] as const) {
      const cereal = provider.resolve({
        ...food("牛奶麥片", "cereal with milk", identityLevel),
        visibleIngredients: ["杏仁片", "黃豆"],
      });
      expect(cereal.profile?.id, identityLevel).toBe("whole-milk");
      expect(cereal.includedInTotal, identityLevel).toBe(true);
    }

    const modifiedMilk = [
      { ...food("熱牛奶", "hot milk", "ingredient"), notes: "燕麥奶" },
      { ...food("凍鮮奶", "iced milk", "ingredient"), notes: "oat milk" },
      { ...food("大牛奶", "cold milk", "ingredient"), visibleIngredients: ["soy milk"] },
      { ...food("細鮮奶", "warm milk", "ingredient"), uncertaintyReasons: ["杏仁奶"] },
      { ...food("暖鮮奶", "a glass of milk", "ingredient"), preparationMethod: "植物奶" },
      { ...food("一杯牛奶", "a cup of milk", "ingredient"), notes: "燕麥奶" },
      { ...food("牛奶", "small milk", "ingredient"), notes: "oat milk" },
      { ...food("鮮奶", "large milk", "ingredient"), visibleIngredients: ["soy milk"] },
      { ...food("全脂奶", "medium milk", "ingredient"), uncertaintyReasons: ["杏仁奶"] },
    ];
    for (const item of modifiedMilk) {
      expect(contradictoryDairyMilkLabel(item), item.displayName).toBe(true);
      const match = provider.resolve(item);
      expect(match.profile?.id, item.displayName).not.toBe("whole-milk");
      expect(match.includedInTotal, item.displayName).toBe(false);
      expect(match.reasons[0], item.displayName).toBe(PLANT_MILK_CONTRADICTION_REASON);
      expect(reachesUsdaLive(item), item.displayName).toBe(false);
    }

    const plainHotMilk = food("熱牛奶", "hot milk", "ingredient");
    expect(contradictoryDairyMilkLabel(plainHotMilk)).toBe(false);
    expect(provider.resolve(plainHotMilk).profile?.id).toBe("whole-milk");

    const notAWarmModifier = { ...food("暫鮮奶", "暫鮮奶", "ingredient"), notes: "燕麥奶" };
    expect(contradictoryDairyMilkLabel(notAWarmModifier)).toBe(false);

    const simplifiedSkim = food("脱脂奶", "脱脂奶", "ingredient");
    expect(contradictoryDairyMilkLabel(simplifiedSkim)).toBe(false);
    expect(provider.resolve(simplifiedSkim).profile?.id).not.toBe("whole-milk");
    expect(reachesUsdaLive(simplifiedSkim)).toBe(true);
    const freshWithSimplifiedSkim = { ...food("鮮奶", "fresh milk", "ingredient"), notes: "脱脂" };
    expect(contradictoryDairyMilkLabel(freshWithSimplifiedSkim)).toBe(false);
    expect(provider.resolve(freshWithSimplifiedSkim).profile?.id).not.toBe("whole-milk");
    expect(reachesUsdaLive(freshWithSimplifiedSkim)).toBe(true);
    const simplifiedSkimPlant = { ...food("脱脂奶", "脱脂奶", "ingredient"), notes: "燕麥奶" };
    expect(contradictoryDairyMilkLabel(simplifiedSkimPlant)).toBe(true);
    expect(reachesUsdaLive(simplifiedSkimPlant)).toBe(false);

    const cupOfTea = { ...food("一杯奶茶", "a cup of milk tea", "dish"), notes: "燕麥奶" };
    expect(contradictoryDairyMilkLabel(cupOfTea)).toBe(false);
    expect(provider.resolve(cupOfTea).profile?.id).toBe("milk-tea");

    const hotTea = {
      ...food("熱奶茶", "hot milk tea", "dish"),
      notes: "燕麥奶",
    };
    expect(contradictoryDairyMilkLabel(hotTea)).toBe(false);
    expect(provider.resolve(hotTea).reasons[0]).not.toBe(PLANT_MILK_CONTRADICTION_REASON);
    expect(provider.resolve(hotTea).profile?.id).toBe("milk-tea");

    for (const item of guarded) {
      const match = provider.resolve(item);
      expect(contradictoryDairyMilkLabel(item), item.displayName).toBe(true);
      expect(match.profile?.id, item.normalizedName).not.toBe("whole-milk");
      expect(match.includedInTotal, item.normalizedName).toBe(false);
      expect(match.coverageReason, item.normalizedName).toBe("INSUFFICIENT_COVERAGE");
      expect(match.reasons[0], item.normalizedName).toBe(PLANT_MILK_CONTRADICTION_REASON);
      expect(reachesUsdaLive(item), item.normalizedName).toBe(false);
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
