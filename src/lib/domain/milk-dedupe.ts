import type { FoodAnalysis, ObservedFood } from "@/lib/domain/food-analysis";
import { containerMilkNameKey, normalizeFoodName } from "@/lib/nutrition/canonical";

export const MERGED_DUPLICATE_MILK_NOTICE =
  "已合併重複嘅牛奶項目，如果係兩杯可以再加返";

function visualEvidenceKey(food: ObservedFood): string {
  const notes = normalizeFoodName(food.notes ?? "");
  const preparation = normalizeFoodName(food.preparationMethod ?? "");
  const ingredients = [...(food.visibleIngredients ?? [])].map((item) => normalizeFoodName(item)).sort().join("|");
  return `${notes}\n${preparation}\n${ingredients}`;
}

/**
 * One carton recognised twice becomes one item. Copies need the same milk
 * name and the same visible notes, preparation, and ingredients. Differing
 * visual evidence stays as separate drinks. Portions are not added together.
 */
function withMergeNotice(food: ObservedFood): ObservedFood {
  if (food.uncertaintyReasons.includes(MERGED_DUPLICATE_MILK_NOTICE)) return food;
  return {
    ...food,
    uncertaintyReasons: [MERGED_DUPLICATE_MILK_NOTICE, ...food.uncertaintyReasons].slice(0, 8),
  };
}

export function dedupeIdenticalContainerMilk(analysis: FoodAnalysis): FoodAnalysis {
  if (!analysis || !Array.isArray(analysis.foods)) return analysis;
  const seen = new Map<string, number>();
  const foods: ObservedFood[] = [];
  let removed = false;
  for (const food of analysis.foods) {
    const nameKey = containerMilkNameKey(food);
    if (!nameKey) {
      foods.push(food);
      continue;
    }
    const key = `${nameKey}\n${visualEvidenceKey(food)}`;
    const keptAt = seen.get(key);
    if (keptAt !== undefined) {
      removed = true;
      foods[keptAt] = withMergeNotice(foods[keptAt]);
      continue;
    }
    seen.set(key, foods.length);
    foods.push(food);
  }
  return removed ? { ...analysis, foods } : analysis;
}
