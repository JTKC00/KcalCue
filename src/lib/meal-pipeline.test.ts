import { describe, expect, it } from "vitest";

import {
  applyPortionPreset,
  createEditableFoodItems,
} from "@/lib/domain/editable-meal";
import { NutritionService } from "@/lib/nutrition/service";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { DemoFoodVisionProvider } from "@/lib/providers/food-vision/demo";

describe("demo meal analysis pipeline", () => {
  it("updates calorie and macro ranges after the user corrects a portion", async () => {
    const vision = new DemoFoodVisionProvider();
    const nutrition = new NutritionService(new LocalNutritionProvider());

    const analysis = await vision.analyzeImage({
      data: "deterministic-demo-input",
      mimeType: "image/jpeg",
    });
    const editableFoods = createEditableFoodItems(analysis.foods);
    const initialMeal = nutrition.calculateMeal(editableFoods);

    expect(analysis.analysisStatus).toBe("success");
    expect(analysis.foods).toHaveLength(4);
    expect(initialMeal.coverage).toBe("complete");
    expect(initialMeal.totals.calories.min).toBeCloseTo(569.4, 8);
    expect(initialMeal.totals.calories.max).toBeCloseTo(762.35, 8);
    expect(initialMeal.midpointCalories).toBeCloseTo(665.875, 8);
    expect(initialMeal.totals.protein.min).toBeCloseTo(40.83, 8);
    expect(initialMeal.totals.protein.max).toBeCloseTo(53.175, 8);
    expect(initialMeal.totals.carbs.min).toBeCloseTo(47.38, 8);
    expect(initialMeal.totals.carbs.max).toBeCloseTo(64.65, 8);
    expect(initialMeal.totals.fat.min).toBeCloseTo(23.15, 8);
    expect(initialMeal.totals.fat.max).toBeCloseTo(31.185, 8);

    const correctedRice = applyPortionPreset(editableFoods[0], "large");
    const correctedMeal = nutrition.calculateMeal([
      correctedRice,
      ...editableFoods.slice(1),
    ]);

    expect(correctedRice).toMatchObject({
      displayName: "白飯",
      portionMin: 188,
      portionMax: 300,
      originalPortionMin: 150,
      originalPortionMax: 200,
    });
    expect(correctedMeal.coverage).toBe("complete");
    expect(correctedMeal.totals.calories.min).toBeCloseTo(618.8, 8);
    expect(correctedMeal.totals.calories.max).toBeCloseTo(892.35, 8);
    expect(correctedMeal.totals.protein.min).toBeCloseTo(41.856, 8);
    expect(correctedMeal.totals.protein.max).toBeCloseTo(55.875, 8);
    expect(correctedMeal.totals.carbs.min).toBeCloseTo(58.096, 8);
    expect(correctedMeal.totals.carbs.max).toBeCloseTo(92.85, 8);
    expect(correctedMeal.totals.fat.min).toBeCloseTo(23.264, 8);
    expect(correctedMeal.totals.fat.max).toBeCloseTo(31.485, 8);
    expect(correctedMeal.midpointCalories).toBeGreaterThan(
      initialMeal.midpointCalories,
    );
  });
});
