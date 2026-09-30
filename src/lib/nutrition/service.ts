import type { ObservedFood } from "@/lib/domain/food-analysis";
import { hasKnownPortion } from "@/lib/domain/editable-meal";
import {
  calculateFoodNutrition,
  calculateMealNutrition,
  type CalculatedMeal,
} from "./calculation";
import type { NutritionMatch, NutritionProvider } from "./types";

export interface ResolvableFood extends ObservedFood {
  nutritionMatch?: NutritionMatch | null;
}

export class NutritionService {
  constructor(private readonly provider: NutritionProvider) {}

  resolveFood(food: ResolvableFood): NutritionMatch | null {
    if (!hasKnownPortion(food)) return null;
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
