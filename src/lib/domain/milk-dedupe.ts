import type { FoodAnalysis, ObservedFood } from "@/lib/domain/food-analysis";
import { containerMilkNameKey, normalizeFoodName } from "@/lib/nutrition/canonical";

export const MERGED_DUPLICATE_MILK_NOTICE =
  "已合併重複嘅牛奶項目，如果係兩杯可以再加返";

const SEPARATE_CONTAINER =
  /另一杯|另一盒|另一瓶|第二杯|第二盒|兩杯|兩盒|兩瓶|兩個杯|兩隻杯|兩個玻璃杯|旁邊|前方|後方|前面|後面|another glass|another cup|second glass|two glasses|two cups|two cartons|front|back|separate|distinct/;
const SAME_SERVING =
  /同一(?:紙盒|盒|瓶|樽|隻杯|杯|玻璃杯|份|容器)|只有一(?:個紙盒|隻杯|個杯)|same (?:carton|bottle|glass|cup|serving|container)|一(?:盒|杯)飲品被(?:拆|分)成兩項/;
const UNCERTAIN_SAME_SERVING =
  /未能|未知|未確定|不確定|無法|未確認|可能|是否|不是|並非|未必|\b(?:not|maybe|might|may|whether|unclear|cannot|could|unsure)\b/;
const CARTON = /紙盒|紙包|利樂|carton|一盒|盒裝/;
const BOTTLE = /瓶子|玻璃樽|一瓶|一樽|瓶裝|(?:^|\s)bottle(?:$|\s)/;
const GLASS = /玻璃杯|杯裝|一杯|(?:^|\s)(?:glass|cup)(?:$|\s)/;
const WRAPPED = /包裝/;

function withMergeNotice(food: ObservedFood): ObservedFood {
  if (food.duplicateMilkNotice === MERGED_DUPLICATE_MILK_NOTICE) return food;
  return { ...food, duplicateMilkNotice: MERGED_DUPLICATE_MILK_NOTICE };
}

function milkRowText(food: ObservedFood): string {
  return [
    food.displayName,
    food.normalizedName,
    food.notes ?? "",
    food.preparationMethod ?? "",
    ...(food.visibleIngredients ?? []),
    ...food.uncertaintyReasons,
  ].join(" ");
}

function containerKinds(food: ObservedFood): Set<"carton" | "bottle" | "glass" | "package"> {
  const text = normalizeFoodName(milkRowText(food));
  const kinds = new Set<"carton" | "bottle" | "glass" | "package">();
  if (CARTON.test(text)) kinds.add("carton");
  if (BOTTLE.test(text)) kinds.add("bottle");
  if (WRAPPED.test(text)) kinds.add("package");
  if (GLASS.test(text)) kinds.add("glass");
  return kinds;
}

type MilkFamily = "oat" | "soy" | "almond" | "coconut" | "dairy" | "generic";

export function isMilkDrink(food: ObservedFood): boolean {
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

function servingEvidence(analysis: FoodAnalysis, foods: readonly ObservedFood[]): string {
  return normalizeFoodName(
    [
      ...foods.map(milkRowText),
      ...analysis.visibleEvidence,
      ...analysis.uncertaintyReasons,
      ...analysis.unknownInformation,
      ...analysis.estimatedInformation,
    ].join(" "),
  );
}

/** A question or negation about the same serving is not an affirmative observation. */
function explicitlySameServing(analysis: FoodAnalysis, foods: readonly ObservedFood[]): boolean {
  const statements = [
    ...foods.flatMap(food => [
      food.displayName, food.normalizedName, food.notes ?? "",
      food.preparationMethod ?? "", ...(food.visibleIngredients ?? []),
      ...food.uncertaintyReasons,
    ]),
    ...analysis.visibleEvidence,
    ...analysis.uncertaintyReasons,
    ...analysis.estimatedInformation,
  ].map(normalizeFoodName).filter(text => SAME_SERVING.test(text));
  return statements.length > 0 && statements.every(text => !UNCERTAIN_SAME_SERVING.test(text));
}

/**
 * Every milk row must carry the same container kind on its own fields.
 * A sandwich that says 包裝, or a meal note that says 紙盒, is not evidence
 * that two milk rows are one item. A carton of 鮮奶 beside a glass of 牛奶
 * does not share a container.
 */
function sameMilkContainer(foods: readonly ObservedFood[]): boolean {
  const kinds = foods.map(containerKinds);
  if (kinds.some((set) => set.size === 0)) return false;
  return [...kinds[0]].some((kind) => kinds.every((set) => set.has(kind)));
}

function pickKept(foods: readonly ObservedFood[]): ObservedFood {
  return foods.reduce((kept, food) => (specificity(food) > specificity(kept) ? food : kept));
}

/** Merge only when the model explicitly describes the same serving. */
export function dedupeIdenticalContainerMilk(analysis: FoodAnalysis): FoodAnalysis {
  if (!analysis || !Array.isArray(analysis.foods)) return analysis;
  const milkIndexes = analysis.foods.flatMap((food, index) => (isMilkDrink(food) ? [index] : []));
  const milkFoods = milkIndexes.map((index) => analysis.foods[index]);
  if (
    milkIndexes.length >= 2 &&
    compatibleFamilies(milkFoods) &&
    sameMilkContainer(milkFoods) &&
    explicitlySameServing(analysis, milkFoods) &&
    !SEPARATE_CONTAINER.test(servingEvidence(analysis, milkFoods))
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
  // One model row may already have swallowed a second container. Do not
  // fabricate a split or portions; surface the existing add/split action.
  if (milkFoods.length === 1) {
    const evidence = normalizeFoodName([
      ...milkFoods.flatMap(food => [
        food.displayName, food.normalizedName, food.notes ?? "",
        food.preparationMethod ?? "", ...(food.visibleIngredients ?? []),
      ]),
      ...analysis.visibleEvidence,
    ].join(" "));
    const cartonAndGlass = CARTON.test(evidence) && GLASS.test(evidence);
    const multipleGlasses = /兩杯|兩隻杯|兩個杯|兩個玻璃杯|two glasses|two cups/.test(evidence) ||
      (/前方|前面|front/.test(evidence) && /後方|後面|back/.test(evidence));
    if ((cartonAndGlass || multipleGlasses) && !explicitlySameServing(analysis, milkFoods)) {
      return {
        ...analysis,
        foods: analysis.foods.map((food, index) =>
          index === milkIndexes[0] ? withMergeNotice(food) : food),
      };
    }
  }
  return analysis;
}
