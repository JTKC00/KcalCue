import type { FoodAnalysis } from "./food-analysis";
import { dedupeIdenticalContainerMilk, isMilkDrink } from "./milk-dedupe";
import { contradictoryDairyMilkLabel, mealPlantMilkContext, normalizeFoodName } from "@/lib/nutrition/canonical";

export const PLANT_MILK_PHOTO_NOTICE = "包裝顯示植物奶，請核對種類及份量。";

/** Notices are application output, never fields requested from the vision model. */
export function preparePhotoMilkAnalysis(analysis: FoodAnalysis): FoodAnalysis {
  if (!analysis || !Array.isArray(analysis.foods)) return analysis;
  const deduped = dedupeIdenticalContainerMilk(analysis);
  const context = mealPlantMilkContext({ analysis: deduped });
  return {
    ...deduped,
    foods: deduped.foods.map(food => {
      if (!isMilkDrink(food)) return food;
      const name = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
      const plantLabel = /燕麥(?:奶|飲品)|燕麦(?:奶|饮品)|豆漿|豆奶|杏仁奶|椰奶|(?:oat|soy|soya|almond|coconut) (?:milk|drink|beverage)/.test(name);
      if (!plantLabel && !contradictoryDairyMilkLabel(food, context)) return food;
      return { ...food, otherMilkNotice: food.otherMilkNotice ?? PLANT_MILK_PHOTO_NOTICE };
    }),
  };
}
