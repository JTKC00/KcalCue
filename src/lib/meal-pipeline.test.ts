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
    expect(initialMeal.includedCount).toBe(4);
    expect(initialMeal.totals.calories.max).toBeGreaterThan(
      initialMeal.totals.calories.min,
    );
    expect(initialMeal.foods.every((food) => food.match?.includedInTotal)).toBe(
      true,
    );

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
    expect(correctedMeal.totals.calories.min).toBeGreaterThan(
      initialMeal.totals.calories.min,
    );
    expect(correctedMeal.midpointCalories).toBeGreaterThan(
      initialMeal.midpointCalories,
    );
  });
});
