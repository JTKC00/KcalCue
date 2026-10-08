import { describe, expect, it } from "vitest";

import { APPENDIX_A_DISHES } from "./coverage-benchmark";
import { resolveCuratedDishIdentity } from "./canonical";
import { localNutritionProfiles } from "./local-data";
import { LocalNutritionProvider } from "./local-provider";
import { calculateRecipe, densityRange } from "./recipe-calculator";
import {
  compiledDishTemplates,
  PILOT_FAMILY_IDS,
  templateNutritionProfiles,
} from "./recipe-templates";
import { nutritionMatchResponseSchema } from "./response-schema";
import type { FoodEstimate } from "@/lib/domain/food-analysis";

const PRESERVED_CALORIES: Record<string, { min: number; max: number }> = {
  "siu-mei-rice": { min: 170, max: 320 },
  "noodle-soup": { min: 70, max: 160 },
  congee: { min: 40, max: 110 },
  "claypot-rice": { min: 170, max: 340 },
  "milk-tea": { min: 45, max: 100 },
  "rice-noodle-roll": { min: 110, max: 190 },
};

function food(displayName: string): FoodEstimate {
  return {
    displayName,
    normalizedName: displayName,
    identityLevel: "dish",
    portionMin: 100,
    portionMax: 100,
    unit: "g",
    recognitionConfidence: 0.9,
    portionConfidence: 0.8,
    uncertaintyReasons: [],
  };
}

describe("recipe templates", () => {
  it("selects the five families with the most benchmark dishes", () => {
    const counts = new Map<string, number>();
    for (const name of APPENDIX_A_DISHES) {
      const resolved = resolveCuratedDishIdentity({ displayName: name, normalizedName: name });
      expect(resolved.status, name).toBe("matched");
      if (resolved.status !== "matched") continue;
      counts.set(resolved.identity.familyId, (counts.get(resolved.identity.familyId) ?? 0) + 1);
    }
    expect(counts.get("rice-plate")).toBe(16);
    expect(counts.get("cha-chaan-teng-noodles")).toBe(7);
    expect(counts.get("dim-sum")).toBe(7);
    expect(counts.get("cha-chaan-teng-breakfast")).toBe(3);
    expect(counts.get("stir-fried-rice-noodles")).toBe(2);
    const selected = new Set<string>(PILOT_FAMILY_IDS);
    for (const [familyId, count] of counts) {
      if (count > 2) expect(selected.has(familyId), familyId).toBe(true);
    }
    expect(selected.has("siu-mei-rice")).toBe(false);
    expect(selected.has("congee")).toBe(false);
    expect(selected.has("wonton-noodle-soup")).toBe(false);
  });

  it("keeps component weights inside the dish total and records a source id per value", () => {
    expect(compiledDishTemplates.length).toBeGreaterThan(30);
    for (const template of compiledDishTemplates) {
      expect(template.calculation.feasible, template.dishId).toBe(true);
      const minWeight = template.components.reduce((total, component) => total + component.gramsAtCalorieMin, 0);
      const maxWeight = template.components.reduce((total, component) => total + component.gramsAtCalorieMax, 0);
      expect(minWeight, template.dishId).toBeCloseTo(template.calculation.feasibleGrams.min, 2);
      expect(maxWeight, template.dishId).toBeCloseTo(template.calculation.feasibleGrams.max, 2);
      for (const component of template.components) {
        expect(component.gramsAtCalorieMin).toBeGreaterThanOrEqual(component.grams.min - 0.001);
        expect(component.gramsAtCalorieMin).toBeLessThanOrEqual(component.grams.max + 0.001);
        expect(component.gramsAtCalorieMax).toBeGreaterThanOrEqual(component.grams.min - 0.001);
        expect(component.gramsAtCalorieMax).toBeLessThanOrEqual(component.grams.max + 0.001);
        expect(component.sourceIds.length).toBeGreaterThan(0);
        expect(component.sourceIds.every((sourceId) => sourceId.startsWith("fdc:"))).toBe(true);
        expect(component.licence).toBe("CC0-1.0");
      }
      expect(template.rangeRatio).toBeGreaterThan(1);
      if (template.rangeRatio > 3) expect(template.complete).toBe(false);
      if (template.rangeRatio > 2.5) expect(template.needsFollowUp).toBe(true);
      if (template.complete) {
        expect(template.profile?.composite).toBe(true);
        expect(template.profile?.canonicalName).toBe(template.dishId);
        expect(template.profile?.nutrientsPer100g.calories).toEqual(template.calculation.per100g.calories);
      }
    }
    expect(compiledDishTemplates.some((template) => template.needsFollowUp && template.complete)).toBe(true);
  });

  it("does not mark a template complete when the calorie ratio exceeds 3", () => {
    const wide = calculateRecipe({
      servingGrams: { min: 100, max: 400 },
      components: [
        {
          grams: { min: 20, max: 300 },
          nutrientsPer100g: densityRange(
            { calories: 40, protein: 1, carbs: 8, fat: 0.2 },
            { calories: 500, protein: 20, carbs: 40, fat: 30 },
          ),
        },
        {
          grams: { min: 10, max: 80 },
          nutrientsPer100g: densityRange({ calories: 20, protein: 1, carbs: 3, fat: 0.1 }),
        },
      ],
    });
    expect(wide.rangeRatio).toBeGreaterThan(3);
    expect(wide.complete).toBe(false);
    expect(wide.needsFollowUp).toBe(true);

    const followUp = calculateRecipe({
      servingGrams: { min: 160, max: 210 },
      components: [
        {
          grams: { min: 90, max: 130 },
          nutrientsPer100g: densityRange({ calories: 110, protein: 3, carbs: 20, fat: 1 }),
        },
        {
          grams: { min: 40, max: 90 },
          nutrientsPer100g: densityRange(
            { calories: 90, protein: 8, carbs: 2, fat: 4 },
            { calories: 310, protein: 14, carbs: 4, fat: 24 },
          ),
        },
      ],
    });
    expect(followUp.rangeRatio).toBeGreaterThan(2.5);
    expect(followUp.rangeRatio).toBeLessThanOrEqual(3);
    expect(followUp.complete).toBe(true);
    expect(followUp.needsFollowUp).toBe(true);
  });

  it("lets the total-weight cap cut the unconstrained calorie maximum", () => {
    const components = [
      {
        grams: { min: 100, max: 200 },
        nutrientsPer100g: densityRange({ calories: 100, protein: 2, carbs: 22, fat: 0.3 }),
      },
      {
        grams: { min: 20, max: 80 },
        nutrientsPer100g: densityRange({ calories: 400, protein: 20, carbs: 0, fat: 30 }),
      },
    ];
    const loose = calculateRecipe({ servingGrams: { min: 120, max: 280 }, components });
    const tight = calculateRecipe({ servingGrams: { min: 150, max: 200 }, components });
    expect(tight.servingCalories.max).toBeLessThan(loose.servingCalories.max);
    expect(tight.feasibleGrams.max).toBeLessThanOrEqual(200);
  });

  it("resolves pilot dishes only as composite template profiles", () => {
    const provider = new LocalNutritionProvider();
    for (const template of compiledDishTemplates.filter((item) => item.complete)) {
      const match = provider.resolve(food(template.displayName));
      expect(match.includedInTotal, template.dishId).toBe(true);
      expect(match.profile?.id, template.dishId).toBe(`template:${template.dishId}`);
      expect(match.profile?.composite, template.dishId).toBe(true);
      expect(match.profile?.id, template.dishId).not.toBe("white-rice-cooked");
      expect(match.profile?.id, template.dishId).not.toBe("pork-cooked");
      expect(match.identity.canonicalName, template.dishId).toBe(template.dishId);
      expect(nutritionMatchResponseSchema.safeParse(match).success, template.dishId).toBe(true);
    }
    expect(templateNutritionProfiles).toHaveLength(
      compiledDishTemplates.filter((template) => template.complete).length,
    );
  });

  it("does not change totals for profiles that predate the templates", () => {
    for (const [id, calories] of Object.entries(PRESERVED_CALORIES)) {
      const profile = localNutritionProfiles.find((item) => item.id === id);
      expect(profile?.nutrientsPer100g.calories, id).toEqual(calories);
      expect(profile?.id.startsWith("template:")).toBe(false);
    }
    const wonton = new LocalNutritionProvider().resolve(food("鮮蝦雲吞麵"));
    expect(wonton.profile?.id).toBe("noodle-soup");
    expect(wonton.profile?.nutrientsPer100g.calories).toEqual({ min: 70, max: 160 });
  });
});
