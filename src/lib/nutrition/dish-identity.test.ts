import { describe, expect, it } from "vitest";

import { APPENDIX_A_DISHES } from "./coverage-benchmark";
import {
  canonicalizeFood,
  normalizeFoodName,
  resolveCuratedDishIdentity,
} from "./canonical";
import { DISH_IDENTITIES } from "./dish-identity";
import { LocalNutritionProvider } from "./local-provider";
import type { FoodEstimate } from "@/lib/domain/food-analysis";

function food(displayName: string, normalizedName: string, identityLevel: FoodEstimate["identityLevel"] = "dish"): FoodEstimate {
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

describe("curated dish identities", () => {
  it("gives every Appendix A dish exactly one identity and no shared alias", () => {
    const owners = new Map<string, string>();
    for (const identity of DISH_IDENTITIES) {
      expect(identity.aliases.length).toBeGreaterThan(0);
      const scripts = new Set(identity.aliases.map((alias) => alias.script));
      expect(scripts.has("english") || identity.aliases.some((alias) => /[a-z]/i.test(alias.text))).toBe(true);
      for (const alias of identity.aliases) {
        const key = normalizeFoodName(alias.text);
        const owner = owners.get(key);
        expect(owner === undefined || owner === identity.id, `${key} 同時屬於 ${owner} 與 ${identity.id}`).toBe(true);
        owners.set(key, identity.id);
      }
    }

    const ids = APPENDIX_A_DISHES.map((name) => {
      const resolved = resolveCuratedDishIdentity({ displayName: name, normalizedName: name });
      expect(resolved.status, name).toBe("matched");
      if (resolved.status !== "matched") return "";
      return resolved.identity.id;
    });
    expect(new Set(ids).size).toBe(APPENDIX_A_DISHES.length);
  });

  it("accepts simplified Chinese and the rice-plate spellings", () => {
    expect(resolveCuratedDishIdentity({ displayName: "叉烧碟头饭", normalizedName: "叉烧碟头饭" })).toMatchObject({
      status: "matched",
      identity: { id: "char-siu-rice-plate", familyId: "rice-plate" },
    });
    expect(resolveCuratedDishIdentity({ displayName: "碗頭飯", normalizedName: "碗頭飯" })).toMatchObject({
      status: "matched",
      identity: { id: "rice-plate", familyId: "rice-plate" },
    });
    expect(resolveCuratedDishIdentity({ displayName: "阳春面", normalizedName: "阳春面" })).toMatchObject({
      status: "matched",
      identity: { id: "plain-noodle-soup", familyId: "cha-chaan-teng-noodles" },
    });
  });

  it("keeps char siu rice on the existing profile and the plate off it", () => {
    const rice = provider.resolve(food("叉燒飯", "char siu rice"));
    expect(rice.includedInTotal).toBe(true);
    expect(rice.profile?.id).toBe("siu-mei-rice");
    expect(rice.identity.dishId).toBe("char-siu-rice");
    expect(rice.identity.hasNutritionProfile).toBe(true);

    const plate = provider.resolve(food("叉燒碟頭飯", "char siu rice plate"));
    expect(plate.includedInTotal).toBe(true);
    expect(plate.profile?.id).toBe("template:char-siu-rice-plate");
    expect(plate.profile?.composite).toBe(true);
    expect(plate.identity.dishId).toBe("char-siu-rice-plate");
    expect(plate.identity.familyId).toBe("rice-plate");
    expect(plate.identity.hasNutritionProfile).toBe(true);
    expect(plate).not.toHaveProperty("coverageReason");

    const englishPlate = provider.resolve(food("char siu rice plate", "char siu rice plate"));
    expect(englishPlate.profile?.id).not.toBe("siu-mei-rice");
    expect(englishPlate.identity.familyId).toBe("rice-plate");
  });

  it("does not let a shorter English name override the Chinese dish", () => {
    const plate = provider.resolve(food("叉燒碟頭飯", "char siu rice"));
    expect(plate.identity.dishId).toBe("char-siu-rice-plate");
    expect(plate.profile?.id).toBe("template:char-siu-rice-plate");
    expect(plate.profile?.id).not.toBe("siu-mei-rice");
    expect(plate.profile?.composite).toBe(true);
    expect(plate.includedInTotal).toBe(true);

    const plain = provider.resolve(food("陽春麵", "noodle soup"));
    expect(plain.identity.dishId).toBe("plain-noodle-soup");
    expect(plain.profile?.id).toBe("template:plain-noodle-soup");
    expect(plain.profile?.id).not.toBe("noodle-soup");
    expect(plain.profile?.composite).toBe(true);
    expect(plain.includedInTotal).toBe(true);

    const genericSoup = provider.resolve(food("湯麵", "noodle soup"));
    expect(genericSoup.profile?.id).toBe("noodle-soup");
    expect(genericSoup.includedInTotal).toBe(true);
  });

  it("refuses to guess when Chinese and English name different dishes", () => {
    const clash = provider.resolve(food("牛肉麵", "wonton noodle soup"));
    expect(clash.includedInTotal).toBe(false);
    expect(clash.profile).toBeNull();
    expect(clash.coverageReason).toBe("AMBIGUOUS_MATCH");
    expect(clash.identity.qualifiers).toContain("ambiguous");
  });

  it("still calculates shrimp wonton noodles with the existing soup profile", () => {
    const match = provider.resolve(food("鮮蝦雲吞麵", "鮮蝦雲吞麵"));
    expect(match.includedInTotal).toBe(true);
    expect(match.profile?.id).toBe("noodle-soup");
    expect(match.identity.dishId).toBe("shrimp-wonton-noodle-soup");
    expect(match.identity.familyId).toBe("wonton-noodle-soup");
    expect(match.identity.hasNutritionProfile).toBe(true);
    expect(match).not.toHaveProperty("coverageReason");
  });

  it("keeps congee on its existing profile and completes dim sum and macaroni through templates", () => {
    expect(canonicalizeFood(food("白粥", "congee")).hasNutritionProfile).toBe(true);
    const siuMai = provider.resolve(food("燒賣", "siu mai"));
    expect(siuMai.identity).toMatchObject({
      dishId: "siu-mai",
      familyId: "dim-sum",
      hasNutritionProfile: true,
    });
    expect(siuMai.profile?.id).toBe("template:siu-mai");
    expect(siuMai.profile?.composite).toBe(true);
    expect(siuMai.includedInTotal).toBe(true);
    const macaroni = provider.resolve(food("通粉湯", "macaroni soup"));
    expect(macaroni.identity).toMatchObject({
      dishId: "macaroni-soup-breakfast",
      familyId: "cha-chaan-teng-breakfast",
      hasNutritionProfile: true,
    });
    expect(macaroni.profile?.id).toBe("template:macaroni-soup-breakfast");
    expect(macaroni.includedInTotal).toBe(true);
    expect(macaroni).not.toHaveProperty("coverageReason");
  });
});
