import type { FoodEstimate } from "@/lib/domain/food-analysis";
import {
  calculateFoodNutrition,
  calculateMealNutrition,
  type CalculatedMeal,
} from "./calculation";
import type { NutritionMatch, NutritionProvider } from "./types";

export interface ResolvableFood extends FoodEstimate {
  nutritionMatch?: NutritionMatch | null;
}

export class NutritionService {
  constructor(private readonly provider: NutritionProvider) {}

  resolveFood(food: ResolvableFood): NutritionMatch {
    if (food.nutritionMatch) return food.nutritionMatch;
    return this.provider.resolve(food);
  }

  calculateMeal(foods: ResolvableFood[]): CalculatedMeal {
    const calculatedFoods = foods.map((food) =>
      calculateFoodNutrition(food, this.resolveFood(food)),
    );
    return calculateMealNutrition(calculatedFoods);
  }
}
