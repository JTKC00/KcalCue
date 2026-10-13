import type { FoodAnalysis, ObservedFood } from "./food-analysis";
import { dedupeIdenticalContainerMilk, isMilkDrink } from "./milk-dedupe";
import { normalizeFoodName } from "@/lib/nutrition/canonical";

export const PLANT_MILK_PHOTO_NOTICE = "包裝顯示植物奶，請核對種類及份量。";

const PACKAGING_LABEL = /紙盒|紙包|利樂|包裝|標籤|標示|盒裝|carton|label/;
const PLANT_MILK_LABEL = /燕麥(?:奶|飲品)|燕麦(?:奶|饮品)|豆漿|豆奶|杏仁奶|椰奶|植物奶|(?:oat|soy|soya|almond|coconut) (?:milk|drink|beverage)|plant milk/;

function withoutUnknownMilkQuestion(text: string): string {
  return text
    .replace(/未能確認是否為[^。；;]*/g, " ")
    .replace(/未能確定是否為[^。；;]*/g, " ")
    .replace(/未知是否為[^。；;]*/g, " ")
    .replace(/不確定是否為[^。；;]*/g, " ")
    .replace(/未能確認是[^。；;]*還是[^。；;]*/g, " ");
}

/** The notice claims the package shows plant milk, so a bare name is not enough. */
export function packagingShowsPlantMilk(text: string): boolean {
  const normalized = normalizeFoodName(withoutUnknownMilkQuestion(text));
  return PACKAGING_LABEL.test(normalized) && PLANT_MILK_LABEL.test(normalized);
}

function plantPackagingStatements(food: ObservedFood, analysis: FoodAnalysis): string[] {
  return [
    food.displayName,
    food.normalizedName,
    food.preparationMethod ?? "",
    food.notes ?? "",
    ...(food.visibleIngredients ?? []),
    ...food.uncertaintyReasons,
    ...analysis.visibleEvidence,
    ...analysis.uncertaintyReasons,
    ...analysis.estimatedInformation,
    ...analysis.unknownInformation,
  ];
}

function withoutPlantPackagingNotice(food: ObservedFood): ObservedFood {
  if (food.otherMilkNotice !== PLANT_MILK_PHOTO_NOTICE) return food;
  const cleared: ObservedFood = { ...food };
  delete cleared.otherMilkNotice;
  return cleared;
}

/** Notices are application output, never fields requested from the vision model. */
export function preparePhotoMilkAnalysis(analysis: FoodAnalysis): FoodAnalysis {
  if (!analysis || !Array.isArray(analysis.foods)) return analysis;
  const deduped = dedupeIdenticalContainerMilk(analysis);
  return {
    ...deduped,
    foods: deduped.foods.map(food => {
      if (!isMilkDrink(food)) return food;
      const labelled = plantPackagingStatements(food, deduped).some(packagingShowsPlantMilk);
      if (!labelled) return withoutPlantPackagingNotice(food);
      return { ...food, otherMilkNotice: food.otherMilkNotice ?? PLANT_MILK_PHOTO_NOTICE };
    }),
  };
}
