import type { FoodAnalysis, ObservedFood } from "@/lib/domain/food-analysis";
import { containerMilkNameKey, normalizeFoodName } from "@/lib/nutrition/canonical";

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
export function dedupeIdenticalContainerMilk(analysis: FoodAnalysis): FoodAnalysis {
  if (!analysis || !Array.isArray(analysis.foods)) return analysis;
  const seen = new Set<string>();
  const foods: ObservedFood[] = [];
  let removed = false;
  for (const food of analysis.foods) {
    const nameKey = containerMilkNameKey(food);
    if (!nameKey) {
      foods.push(food);
      continue;
    }
    const key = `${nameKey}\n${visualEvidenceKey(food)}`;
    if (seen.has(key)) {
      removed = true;
      continue;
    }
    seen.add(key);
    foods.push(food);
  }
  return removed ? { ...analysis, foods } : analysis;
}
