import { normalizeFoodName, type MealPlantMilkContext } from "./canonical";
import { localNutritionProfiles, LOCAL_DATA_NOTICE } from "./local-data";
import { findProfileByNormalizedName, resolveNutritionMatch } from "./resolver";
import type { NutritionMatch, NutritionProfile, NutritionProvider } from "./types";
import type { FoodEstimate } from "@/lib/domain/food-analysis";

export { normalizeFoodName };

export class LocalNutritionProvider implements NutritionProvider {
  readonly id = "local-reference";
  readonly dataNotice = LOCAL_DATA_NOTICE;

  resolve(food: FoodEstimate, mealContext?: MealPlantMilkContext): NutritionMatch {
    return resolveNutritionMatch(food, localNutritionProfiles, mealContext);
  }

  findByName(name: string): NutritionProfile | null {
    return findProfileByNormalizedName(name, localNutritionProfiles);
  }

  listFoods(): NutritionProfile[] {
    return localNutritionProfiles.map((profile) => ({ ...profile }));
  }
}
