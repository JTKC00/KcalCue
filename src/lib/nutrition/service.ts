import type { FoodEstimate } from "@/lib/domain/food-analysis";
import {
  calculateFoodNutrition,
  calculateMealNutrition,
  type CalculatedMeal,
} from "./calculation";
import type { NutritionProvider } from "./types";

export class NutritionService {
  constructor(private readonly provider: NutritionProvider) {}

  calculateMeal(foods: FoodEstimate[]): CalculatedMeal {
    const calculatedFoods = foods.map((food) => {
      const profile =
        this.provider.findByName(food.normalizedName) ??
        this.provider.findByName(food.displayName);
      return calculateFoodNutrition(food, profile);
    });

    return calculateMealNutrition(calculatedFoods);
  }
}
