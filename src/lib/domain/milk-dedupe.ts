import type { FoodAnalysis, ObservedFood } from "@/lib/domain/food-analysis";
import { containerMilkNameKey, normalizeFoodName } from "@/lib/nutrition/canonical";

export const MERGED_DUPLICATE_MILK_NOTICE =
  "已合併重複嘅牛奶項目，如果係兩杯可以再加返";

/**
 * Not the merged notice. Extra rows stay visible but stay out of the
 * confirmed total until the user says they are a separate serving.
 */
export const SUSPECTED_DUPLICATE_MILK_NOTICE =
  "可能係同一份飲品重複列出。請確認係一份定係分開嘅份量；未確認前，多餘項目唔會計入總 kcal。";

const SEPARATE_CONTAINER =
  /另一杯|另一盒|另一瓶|第二杯|第二盒|兩杯|兩盒|兩瓶|兩個杯|兩隻杯|兩個玻璃杯|旁邊|前方|後方|前面|後面|another glass|another cup|second glass|two glasses|two cups|two cartons|front|back|separate|distinct/;
const SAME_SERVING =
  /同一(?:紙盒|盒|瓶|樽|隻杯|杯|玻璃杯|份|容器)|只有一(?:個紙盒|隻杯|個杯)|same (?:carton|bottle|glass|cup|serving|container)|一(?:盒|杯)飲品被(?:拆|分)成兩項/;
const UNCERTAIN_SAME_SERVING =
  /未能|未知|未確定|不確定|無法|未確認|可能|是否|不是|並非|未必|\b(?:not|maybe|might|may|whether|unclear|cannot|could|unsure)\b/;
const NEGATED_SAME_SERVING =
  /不是同一|並非同一|並不是同一|不是同一個|不同(?:紙盒|盒|杯|瓶|樽|容器)|not the same|different (?:carton|bottle|cup|glass|container)/;
const CARTON = /紙盒|紙包|利樂|carton|一盒|盒裝/;
const BOTTLE = /瓶子|玻璃樽|一瓶|一樽|瓶裝|(?:^|\s)bottle(?:$|\s)/;
const GLASS = /玻璃杯|杯裝|一杯|(?:^|\s)(?:glass|cup)(?:$|\s)/;
const WRAPPED = /包裝/;

function releaseSuspect(food: ObservedFood): ObservedFood {
  if (food.suspectedDuplicateMilk !== true) return food;
  const cleared: ObservedFood = { ...food };
  delete cleared.suspectedDuplicateMilk;
  return cleared;
}

function withMergeNotice(food: ObservedFood): ObservedFood {
  const cleared = releaseSuspect(food);
  if (cleared.duplicateMilkNotice === MERGED_DUPLICATE_MILK_NOTICE) return cleared;
  return { ...cleared, duplicateMilkNotice: MERGED_DUPLICATE_MILK_NOTICE };
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

function rowStatements(foods: readonly ObservedFood[]): string[] {
  return foods.flatMap(food => [
    food.displayName, food.normalizedName, food.notes ?? "",
    food.preparationMethod ?? "", ...(food.visibleIngredients ?? []),
    ...food.uncertaintyReasons,
  ]);
}

function evidenceStatements(analysis: FoodAnalysis, foods: readonly ObservedFood[], includeUnknown: boolean): string[] {
  return [
    ...rowStatements(foods),
    ...analysis.visibleEvidence,
    ...analysis.uncertaintyReasons,
    ...analysis.estimatedInformation,
    ...(includeUnknown ? analysis.unknownInformation : []),
  ].map(normalizeFoodName);
}

function servingEvidence(analysis: FoodAnalysis, foods: readonly ObservedFood[]): string {
  return evidenceStatements(analysis, foods, true).join(" ");
}

/** A question or negation about the same serving is not an affirmative observation. */
function explicitlySameServing(analysis: FoodAnalysis, foods: readonly ObservedFood[]): boolean {
  const statements = evidenceStatements(analysis, foods, false).filter(text => SAME_SERVING.test(text));
  return statements.length > 0 && statements.every(text => !UNCERTAIN_SAME_SERVING.test(text));
}

function uncertainSameServing(analysis: FoodAnalysis, foods: readonly ObservedFood[]): boolean {
  return evidenceStatements(analysis, foods, true).some(text =>
    SAME_SERVING.test(text) && UNCERTAIN_SAME_SERVING.test(text));
}

function negatedDistinctServing(analysis: FoodAnalysis, foods: readonly ObservedFood[]): boolean {
  return evidenceStatements(analysis, foods, true).some(text => NEGATED_SAME_SERVING.test(text));
}

/**
 * Carton beside a glass, or a bottle beside a glass, are two containers
 * even when the model never says 另一杯.
 */
function distinctPhysicalContainers(foods: readonly ObservedFood[]): boolean {
  const present = new Set(foods.flatMap(food => [...containerKinds(food)]));
  const pairs = [
    ["carton", "glass"],
    ["bottle", "glass"],
    ["package", "glass"],
    ["carton", "bottle"],
  ] as const;
  return pairs.some(([left, right]) => present.has(left) && present.has(right));
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

function sameCanonicalKey(foods: readonly ObservedFood[]): boolean {
  const keys = foods.map(containerMilkNameKey);
  const first = keys[0];
  return Boolean(first) && keys.every((key) => key === first);
}

function pickKept(foods: readonly ObservedFood[]): ObservedFood {
  return foods.reduce((kept, food) => (specificity(food) > specificity(kept) ? food : kept));
}

function mergeMilkRows(analysis: FoodAnalysis, milkIndexes: readonly number[], milkFoods: readonly ObservedFood[]): FoodAnalysis {
  const drop = new Set(milkIndexes);
  const preferred = withMergeNotice(pickKept(milkFoods));
  let inserted = false;
  const foods: ObservedFood[] = [];
  for (let index = 0; index < analysis.foods.length; index += 1) {
    if (!drop.has(index)) {
      foods.push(releaseSuspect(analysis.foods[index]));
      continue;
    }
    if (!inserted) {
      foods.push(preferred);
      inserted = true;
    }
  }
  return { ...analysis, foods };
}

function markSuspectedDuplicates(
  analysis: FoodAnalysis,
  milkIndexes: readonly number[],
): FoodAnalysis {
  const group = new Set(milkIndexes);
  const preferred = milkIndexes.reduce((best, index) => (
    specificity(analysis.foods[index]) > specificity(analysis.foods[best]) ? index : best
  ));
  return {
    ...analysis,
    foods: analysis.foods.map((food, index) => {
      const cleared = releaseSuspect(food);
      if (!group.has(index) || index === preferred) return cleared;
      return { ...cleared, suspectedDuplicateMilk: true };
    }),
  };
}

/**
 * Merge only with shared-container evidence and no sign of a second container.
 * Identical canonical keys on the same container kind are enough: the model
 * often writes 「只顯示一盒」 instead of 「同一盒」. Same-family rows that
 * lack that evidence stay on screen for confirmation and do not count twice.
 */
export function dedupeIdenticalContainerMilk(analysis: FoodAnalysis): FoodAnalysis {
  if (!analysis || !Array.isArray(analysis.foods)) return analysis;
  const milkIndexes = analysis.foods.flatMap((food, index) => (isMilkDrink(food) ? [index] : []));
  const milkFoods = milkIndexes.map((index) => analysis.foods[index]);
  if (milkIndexes.length >= 2 && compatibleFamilies(milkFoods)) {
    const evidence = servingEvidence(analysis, milkFoods);
    const cartonAndGlass = CARTON.test(evidence) && GLASS.test(evidence);
    const bottleAndGlass = BOTTLE.test(evidence) && GLASS.test(evidence);
    const separate = SEPARATE_CONTAINER.test(evidence)
      || distinctPhysicalContainers(milkFoods)
      || cartonAndGlass
      || bottleAndGlass;
    const uncertain = uncertainSameServing(analysis, milkFoods);
    const negated = negatedDistinctServing(analysis, milkFoods);
    if (
      !separate &&
      !uncertain &&
      !negated &&
      sameMilkContainer(milkFoods) &&
      (explicitlySameServing(analysis, milkFoods) || sameCanonicalKey(milkFoods))
    ) {
      return mergeMilkRows(analysis, milkIndexes, milkFoods);
    }
    if (!separate && !negated) {
      return markSuspectedDuplicates(analysis, milkIndexes);
    }
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
          index === milkIndexes[0] ? withMergeNotice(food) : releaseSuspect(food)),
      };
    }
  }
  if (!analysis.foods.some(food => food.suspectedDuplicateMilk === true)) return analysis;
  return { ...analysis, foods: analysis.foods.map(releaseSuspect) };
}
