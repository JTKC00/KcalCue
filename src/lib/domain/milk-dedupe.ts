import type { FoodAnalysis, ObservedFood } from "@/lib/domain/food-analysis";
import { containerMilkNameKey, normalizeFoodName } from "@/lib/nutrition/canonical";

export const MERGED_DUPLICATE_MILK_NOTICE =
  "已合併重複嘅牛奶項目，如果係兩杯可以再加返";

const SEPARATE_CONTAINER =
  /另一杯|另一盒|另一瓶|第二杯|第二盒|兩杯|兩盒|兩瓶|兩個杯|旁邊|another glass|another cup|second glass|two glasses|two cups|two cartons/;

const ONE_CONTAINER =
  /紙盒|紙包|利樂|carton|bottle|瓶子|玻璃樽|一盒|一瓶|一樽|盒裝|瓶裝|包裝/;

function visualEvidenceKey(food: ObservedFood): string {
  const notes = normalizeFoodName(food.notes ?? "");
  const preparation = normalizeFoodName(food.preparationMethod ?? "");
  const ingredients = [...(food.visibleIngredients ?? [])].map((item) => normalizeFoodName(item)).sort().join("|");
  return `${notes}\n${preparation}\n${ingredients}`;
}

function withMergeNotice(food: ObservedFood): ObservedFood {
  if (food.duplicateMilkNotice === MERGED_DUPLICATE_MILK_NOTICE) return food;
  return { ...food, duplicateMilkNotice: MERGED_DUPLICATE_MILK_NOTICE };
}

function evidenceBlob(analysis: FoodAnalysis, foods: readonly ObservedFood[]): string {
  return normalizeFoodName(
    [
      ...analysis.visibleEvidence,
      ...analysis.uncertaintyReasons,
      ...analysis.unknownInformation,
      ...analysis.estimatedInformation,
      ...foods.flatMap((food) => [
        food.displayName,
        food.normalizedName,
        food.notes ?? "",
        food.preparationMethod ?? "",
        ...(food.visibleIngredients ?? []),
        ...food.uncertaintyReasons,
      ]),
    ].join(" "),
  );
}

type MilkFamily = "oat" | "soy" | "almond" | "coconut" | "dairy" | "generic";

function isMergeableMilk(food: ObservedFood): boolean {
  if (containerMilkNameKey(food)) return true;
  const text = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  if (/粥|麥片|麦片|布甸|布丁|奶茶|(?:^|\s)(?:tea|cereal|porridge|pudding)(?:$|\s)/.test(text)) return false;
  if (/燕麥|燕麦/.test(text) && /奶|飲|milk|drink|beverage/.test(text)) return true;
  if (/(?:^|\s)oat(?:$|\s)/.test(text) && /奶|milk|drink|beverage/.test(text)) return true;
  return false;
}

function milkFamily(food: ObservedFood): MilkFamily {
  const text = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  if (/燕麥奶|燕麦奶|(?:^|\s)oat milk(?:$|\s)/.test(text)) return "oat";
  if (/燕麥|燕麦|(?:^|\s)oat(?:$|\s)/.test(text)) return "oat";
  if (/豆漿|豆奶|(?:^|\s)(?:soy|soya)(?:$|\s)/.test(text)) return "soy";
  if (/杏仁奶|(?:^|\s)almond milk(?:$|\s)/.test(text)) return "almond";
  if (/椰奶|(?:^|\s)coconut milk(?:$|\s)/.test(text)) return "coconut";
  if (/全脂|低脂|脫脂|脱脂|鮮奶|(?:^|\s)(?:whole milk|fresh milk|skim milk|low-fat milk|low fat milk)(?:$|\s)/.test(text)) {
    return "dairy";
  }
  return "generic";
}

function specificity(food: ObservedFood): number {
  const family = milkFamily(food);
  if (family === "generic") return 1;
  const text = normalizeFoodName(`${food.displayName} ${food.normalizedName}`);
  if (/燕麥奶|燕麦奶|豆漿|杏仁奶|椰奶|(?:^|\s)(?:oat milk|soy milk|almond milk|coconut milk)(?:$|\s)/.test(text)) return 3;
  return 2;
}

function compatibleFamilies(foods: readonly ObservedFood[]): boolean {
  const specific = new Set(foods.map(milkFamily).filter((family) => family !== "generic"));
  return specific.size <= 1;
}

function indicatesOneContainer(analysis: FoodAnalysis, foods: readonly ObservedFood[]): boolean {
  const blob = evidenceBlob(analysis, foods);
  if (SEPARATE_CONTAINER.test(blob)) return false;
  return ONE_CONTAINER.test(blob);
}

function pickKept(foods: readonly ObservedFood[]): ObservedFood {
  return foods.reduce((kept, food) => (specificity(food) > specificity(kept) ? food : kept));
}

/**
 * One carton recognised as several milk rows becomes one item.
 * Name variants (燕麥奶 / 燕麥飲品 / 紙盒燕麥奶), a generic row plus a
 * specific row, and different portions still merge when the text describes
 * one package and not a second cup. Portions are not added. The notice is
 * its own field, not an uncertainty reason.
 * Identical copies with the same visible notes still merge when there is
 * no package word. A different note such as 旁邊另一杯 stays separate.
 */
function mergeIdenticalKeys(analysis: FoodAnalysis): FoodAnalysis {
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

export function dedupeIdenticalContainerMilk(analysis: FoodAnalysis): FoodAnalysis {
  if (!analysis || !Array.isArray(analysis.foods)) return analysis;
  const milkIndexes = analysis.foods.flatMap((food, index) => (isMergeableMilk(food) ? [index] : []));
  const milkFoods = milkIndexes.map((index) => analysis.foods[index]);
  if (
    milkIndexes.length >= 2 &&
    compatibleFamilies(milkFoods) &&
    indicatesOneContainer(analysis, milkFoods)
  ) {
    const drop = new Set(milkIndexes);
    const preferred = withMergeNotice(pickKept(milkFoods));
    let inserted = false;
    const foods: ObservedFood[] = [];
    for (let index = 0; index < analysis.foods.length; index += 1) {
      if (!drop.has(index)) {
        foods.push(analysis.foods[index]);
        continue;
      }
      if (!inserted) {
        foods.push(preferred);
        inserted = true;
      }
    }
    return { ...analysis, foods };
  }
  return mergeIdenticalKeys(analysis);
}
