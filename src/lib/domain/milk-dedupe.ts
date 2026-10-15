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

function joinedRowText(foods: readonly ObservedFood[]): string {
  return normalizeFoodName(foods.map(milkRowText).join(" "));
}

/**
 * A second container has to be written on the milk rows themselves.
 * Meal-level text that merely mentions a 杯 is not enough to count both rows.
 */
function rowsShowDistinctContainers(foods: readonly ObservedFood[]): boolean {
  const text = joinedRowText(foods);
  const opposed = (/左邊|左侧/.test(text) && /右邊|右侧/.test(text))
    || (/前方|前面|front/.test(text) && /後方|後面|back/.test(text));
  return SEPARATE_CONTAINER.test(text)
    || opposed
    || distinctPhysicalContainers(foods)
    || (CARTON.test(text) && GLASS.test(text))
    || (BOTTLE.test(text) && GLASS.test(text));
}

/** Meal text can suggest another container, but that is a question for the user. */
function mealOnlySuggestsAnotherContainer(analysis: FoodAnalysis, foods: readonly ObservedFood[]): boolean {
  if (rowsShowDistinctContainers(foods)) return false;
  const evidence = servingEvidence(analysis, foods);
  return SEPARATE_CONTAINER.test(evidence)
    || (CARTON.test(evidence) && GLASS.test(evidence))
    || (BOTTLE.test(evidence) && GLASS.test(evidence));
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
 * Multi-row scenes are not one milk container. Build candidate groups by
 * milk family and by the physical kind named on each row. A separate glass
 * must never disable deduplication of a carton elsewhere in the same photo.
 *
 * Generic "milk" may join an explicit family only when its container kind
 * points to exactly one such family; otherwise we avoid guessing its identity.
 */
function candidateMilkGroups(foods: readonly ObservedFood[], milkIndexes: readonly number[]): number[][] {
  type ContainerKind = "carton" | "bottle" | "glass" | "package" | "unknown" | "mixed";
  const kind = (food: ObservedFood): ContainerKind => {
    // A row's name / preparation identifies *its own* vessel more reliably
    // than a note that may describe other items elsewhere in the photo.
    const ownVessel = containerKinds({
      ...food,
      notes: undefined,
      visibleIngredients: undefined,
      uncertaintyReasons: [],
    });
    const kinds = ownVessel.size > 0 ? ownVessel : containerKinds(food);
    if (kinds.has("carton")) kinds.delete("package"); // package is often the carton wrapper
    if (kinds.size === 0) return "unknown";
    if (kinds.size > 1) return "mixed";
    return [...kinds][0];
  };
  const entries = milkIndexes.map(index => ({
    index, family: milkFamily(foods[index]), kind: kind(foods[index]),
  }));
  const resolved = entries.map(entry => {
    if (entry.family !== "generic") return { ...entry };
    const eligible = new Set(entries.filter(other =>
      other.family !== "generic" &&
      (entry.kind === "unknown" || (entry.kind !== "mixed" && other.kind === entry.kind))
    ).map(other => other.family));
    return { ...entry, family: eligible.size === 1 ? [...eligible][0] : entry.family };
  });

  const groups = new Map<string, number[]>();
  for (const entry of resolved) {
    // An unknown container can share the only concrete container kind in its
    // family; with multiple kinds it remains separate, not silently dropped.
    const possibleKinds = new Set(resolved.filter(other =>
      other.family === entry.family && other.kind !== "unknown" && other.kind !== "mixed"
    ).map(other => other.kind));
    const effectiveKind = entry.kind === "unknown" && possibleKinds.size === 1
      ? [...possibleKinds][0] : entry.kind;
    const key = `${entry.family}:${effectiveKind}`;
    groups.set(key, [...(groups.get(key) ?? []), entry.index]);
  }
  return [...groups.values()].filter(group => group.length >= 2);
}

/**
 * Derive a *bounded* physical serving count, rather than treating a mention of
 * "two cartons" as an all-or-nothing pass for arbitrarily many model rows.
 * An unmatched or contradictory row remains visible for explicit confirmation.
 *
 * Only cite an entire-meal count for this milk group when it actually refers
 * to its family, or this is the ONLY milk group with the same vessel kind.
 * Row-level descriptions of individual cartons are not additive evidence:
 * a duplicated model row can itself say "one carton" twice.
 */
function evidencedMilkCount(
  analysis: FoodAnalysis,
  group: readonly ObservedFood[],
): number {
  const family = group.map(milkFamily).find(value => value !== "generic") ?? "generic";
  const markers: Record<MilkFamily, RegExp> = {
    oat: /燕麥|燕麦|\boat\b/i,
    soy: /豆漿|豆浆|豆奶|\bsoy(?:a)?\b/i,
    almond: /杏仁|\balmond\b/i,
    coconut: /椰奶|椰子|\bcoconut\b/i,
    dairy: /全脂|低脂|脫脂|脱脂|鮮奶|鲜奶|牛奶|\b(?:dairy|whole milk|fresh milk|skim milk)\b/i,
    generic: /牛奶|乳|\bmilk\b/i,
  };
  const vessel = (() => {
    const kinds = new Set(group.flatMap(row => [...containerKinds({
      ...row, notes: undefined, visibleIngredients: undefined, uncertaintyReasons: [],
    })]));
    if (kinds.has("carton")) return "carton";
    if (kinds.has("bottle")) return "bottle";
    if (kinds.has("glass")) return "glass";
    return "unknown";
  })();
  const number = (raw: string): number | null => {
    const value = normalizeFoodName(raw);
    if (/^[1-9]$/.test(value)) return Number(value);
    const names: Record<string, number> = {
      一: 1, 二: 2, 兩: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
      one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
    };
    return names[value] ?? null;
  };
  const chineseUnit = vessel === "glass" ? "(?:玻璃杯|杯)" :
    vessel === "bottle" ? "(?:瓶|樽)" : "(?:紙盒|盒|包)";
  const englishUnit = vessel === "glass" ? "glasses|cups?" :
    vessel === "bottle" ? "bottles?" : "cartons?|packages?";
  const quantity = new RegExp(
    `([一二兩两三四五六七八九1-9])\\s*(?:個|个|隻|只)?\\s*${chineseUnit}|\\b(one|two|three|four|five|six|seven|eight|nine|[1-9])\\s+(?:[a-z-]+\\s+){0,3}(?:${englishUnit})\\b`,
    "gi",
  );
  // Do not promote absence, negation, tentative language or a question to
  // positive quantity evidence. This gate applies equally to meal-level text
  // and individual model rows. It is intentionally conservative.
  const affirmativeCountEvidence = (raw: string): boolean => {
    // normalizeFoodName strips punctuation, including the question mark.
    // Evaluate interrogation polarity against the original source first.
    if (/[?？]/.test(raw)) return false;
    const text = normalizeFoodName(raw);
    return !/沒有|没有|没|未見|未见|未有|未能|未知|未確|未确|不確|不确|不能|不見|不见|並非|并非|不是|並不|并不|無法|无法|可能|或許|或许|疑似|估計|估计|是否|大概|\b(?:no|not|without|none|neither|never|maybe|might|may|perhaps|whether|unclear|unsure|uncertain|unknown|cannot|could|possibly|apparently)\b/i.test(text);
  };
  const specificFamilies = (text: string): MilkFamily[] =>
    (["oat", "soy", "almond", "coconut", "dairy"] as const).filter(candidate =>
      markers[candidate].test(text));

  const perRowRaw = group.map(milkRowText);
  const statements = [
    ...analysis.visibleEvidence, ...analysis.estimatedInformation,
    ...analysis.uncertaintyReasons, ...analysis.unknownInformation,
  ];

  // A row can describe other containers in its notes. Only an explicit
  // *same-family and same-vessel* referent may raise this group's count.
  // "燕麥奶紙盒，另一杯" describes a cup, not a second oat carton.
  const sameVessel = vessel === "carton" ? /紙盒|紙包|盒|包|carton|package/i
    : vessel === "bottle" ? /瓶|樽|bottle/i
      : vessel === "glass" ? /杯|glass|cup/i
        : vessel === "unknown" ? /$^/ : /包|package/i;
  const separateVessel = vessel === "carton"
    ? /另一(?:個|个)?(?:紙盒|纸盒|盒|包)|第二(?:個|个)?(?:紙盒|纸盒|盒|包)|another\s+(?:carton|package)|second\s+(?:carton|package)/gi
    : vessel === "bottle"
      ? /另一(?:支|個|个)?(?:瓶|樽)|第二(?:支|個|个)?(?:瓶|樽)|another\s+bottle|second\s+bottle/gi
      : vessel === "glass"
        ? /另一(?:個|个|隻|只)?(?:玻璃杯|杯)|第二(?:個|个|隻|只)?(?:玻璃杯|杯)|another\s+(?:glass|cup)|second\s+(?:glass|cup)/gi
        : /$^/g;
  const clauses = (raw: string): string[] =>
    raw.split(/[，,。；;!?？]/).map(item => item.trim()).filter(Boolean);
  const sameFamilyOnly = (text: string): boolean => {
    const found = specificFamilies(text);
    return found.length === 1 && found[0] === family;
  };

  // An explicit "another carton of oat milk" is group-specific. Bare "another
  // carton" is not: it could be soy or an unidentified drink. We intentionally
  // cannot infer a second oat carton from the food row's *own* identity alone.
  const namedSecondVessel = group.some(food => {
    const note = food.notes ?? "";
    if (!affirmativeCountEvidence(note)) return false;
    return clauses(note).some(clause =>
      [...clause.matchAll(separateVessel)].some(match => {
        const following = clause.slice((match.index ?? 0) + match[0].length);
        return sameFamilyOnly(following);
      }));
  });

  // Location words must identify two *different food rows* as physical
  // containers in this subgroup. A duplicated note containing both "left"
  // and "right" does not prove two servings.
  const positionedRows = group.map(food => {
    const note = food.notes ?? "";
    if (!affirmativeCountEvidence(note)) return new Set<string>();
    const positions = new Set<string>();
    for (const clause of clauses(note)) {
      if (!sameFamilyOnly(clause) || !sameVessel.test(clause)) continue;
      const left = /左邊|左边|左側|左侧|\bleft\b/i.test(clause);
      const right = /右邊|右边|右側|右侧|\bright\b/i.test(clause);
      const front = /前方|前面|\bfront\b/i.test(clause);
      const back = /後方|后方|後面|后面|\bback\b/i.test(clause);
      if (left && !right) positions.add("left");
      if (right && !left) positions.add("right");
      if (front && !back) positions.add("front");
      if (back && !front) positions.add("back");
    }
    return positions;
  });
  const distinctPositionedRows = (a: string, b: string) =>
    positionedRows.some((positions, i) => positions.has(a) && !positions.has(b) &&
      positionedRows.some((other, j) => i !== j && other.has(b) && !other.has(a)));

  // A negation of sameness asserts two containers only if it actually names
  // this group's vessel type in a model-row note. "not the same glass" must
  // never validate another oat carton.
  const maybeDistinct = evidenceStatements(analysis, group, true).some(text =>
    NEGATED_SAME_SERVING.test(text) &&
    /未能|未知|未確認|未确定|不確定|不确定|可能|是否|\b(?:maybe|might|unclear|whether|unknown|perhaps)\b/i.test(text));
  const scopedDistinct = !maybeDistinct && group.some(food =>
    clauses(food.notes ?? "").some(clause =>
      NEGATED_SAME_SERVING.test(normalizeFoodName(clause))
      && sameVessel.test(clause)
      && (specificFamilies(clause).length === 0 || sameFamilyOnly(clause))));
  const minimumCount = namedSecondVessel
    || distinctPositionedRows("left", "right")
    || distinctPositionedRows("front", "back")
    || scopedDistinct ? 2 : 1;

  // Rows may repeat "一盒" because the model duplicated a serving. However,
  // an explicit two/three-plus count on an individual row is useful evidence
  // when it identifies this family and vessel.
  const countStatements = [
    ...statements.map(value => ({ value, fromRow: false })),
    ...perRowRaw.map(value => ({ value, fromRow: true })),
  ];
  const validCounts: number[] = [];
  for (const { value: raw, fromRow } of countStatements) {
    // Keep comma/clause boundaries intact for family attribution.
    // Normalizing the entire statement here would erase punctuation and
    // incorrectly bind 「兩盒燕麥奶，另一杯牛奶」 to both families.
    const value = raw.toLowerCase().replace(/\s+/g, " ").trim();
    if (!affirmativeCountEvidence(raw) ||
        /不止|超過|超过|more than|at least/i.test(value)) continue;
    const matches = [...value.matchAll(quantity)];
    for (const [offset, match] of matches.entries()) {
      const count = number(match[1] ?? match[2]);
      if (count === null || (fromRow && count === 1)) continue;
      const start = match.index ?? 0;
      const after = matches[offset + 1]?.index ?? value.length;
      const beforePunctuation = value.lastIndexOf("，", start);
      const beforeComma = value.lastIndexOf(",", start);
      const beforePeriod = value.lastIndexOf("。", start);
      const from = Math.max(beforePunctuation, beforeComma, beforePeriod) + 1;
      const punctuationAfter = ["，", ",", "。", ";", "；"].map(p => value.indexOf(p, start))
        .filter(x => x >= 0);
      const to = Math.min(after, ...punctuationAfter, value.length);
      // Bind count to the milk family immediately after the quantity when
      // possible (「兩盒豆漿」 / "two cartons of soy milk"), otherwise to a
      // uniquely named family immediately before it (「燕麥奶兩盒」).
      // Never infer a milk family from another row's name or from a different
      // family mentioned elsewhere in the overall meal.
      const afterCount = value.slice(start + match[0].length, to);
      const beforeCount = value.slice(from, start);
      const afterFamilies = specificFamilies(match[0] + afterCount);
      const beforeFamilies = specificFamilies(beforeCount);
      const boundFamilies = afterFamilies.length > 0 ? afterFamilies : beforeFamilies;
      if (boundFamilies.length !== 1 || boundFamilies[0] !== family) continue;
      // When the count describes several drinks in a single clause, it cannot
      // belong wholly to any one milk subgroup, even if that other milk type
      // was omitted from the model's foods array.
      if (specificFamilies(value.slice(from, to)).some(other => other !== family)
          && matches.length === 1) continue;
      validCounts.push(count);
    }
  }
  if (validCounts.length > 0) {
    // Contradictory observations are not proof for the larger count. Withhold
    // the disputed surplus until the user confirms it.
    return Math.min(...validCounts);
  }
  return minimumCount;
}

function dedupeMultipleMilkGroups(analysis: FoodAnalysis, milkIndexes: readonly number[]): FoodAnalysis {
  const groups = candidateMilkGroups(analysis.foods, milkIndexes);
  if (groups.length === 0) return analysis;
  const replacements = new Map<number, ObservedFood>();
  for (const indexes of groups) {
    const group = indexes.map(index => analysis.foods[index]);
    const confirmedLimit = Math.min(indexes.length, Math.max(1,
      evidencedMilkCount(analysis, group)));
    // Preserve original order and separate vessel identities. Never silently
    // merge a group of 3+ rows: only confirmed rows contribute nutrients.
    for (const [ordinal, index] of indexes.entries()) {
      const cleared = releaseSuspect(analysis.foods[index]);
      replacements.set(index, ordinal < confirmedLimit
        ? cleared : { ...cleared, suspectedDuplicateMilk: true });
    }
  }
  return {
    ...analysis,
    foods: analysis.foods.map((food, index) => replacements.get(index) ?? food),
  };
}

/**
 * Merge only with shared-container evidence and no sign of a second container.
 * Identical canonical keys on the same container kind are enough: the model
 * often writes 「只顯示一盒」 instead of 「同一盒」. That merge is conservative
 * and can undercount two real cartons of the same drink. Same-family rows that
 * lack that evidence, including a 杯 that appears only in meal text, stay on
 * screen for confirmation and do not count twice.
 */
export function dedupeIdenticalContainerMilk(analysis: FoodAnalysis): FoodAnalysis {
  if (!analysis || !Array.isArray(analysis.foods)) return analysis;
  const milkIndexes = analysis.foods.flatMap((food, index) => (isMilkDrink(food) ? [index] : []));
  const milkFoods = milkIndexes.map((index) => analysis.foods[index]);
  if (milkIndexes.length >= 3) return dedupeMultipleMilkGroups(analysis, milkIndexes);
  // The original two-row deduper must also respect positive count evidence.
  // If the photo explicitly contains two or more distinct cartons, never
  // collapse both model rows into one just because the names and kinds match.
  // We do not invent missing rows when the photo has more than the AI found.
  if (milkIndexes.length === 2 && compatibleFamilies(milkFoods)
      && sameMilkContainer(milkFoods)
      && evidencedMilkCount(analysis, milkFoods) >= 2) {
    return analysis;
  }
  if (milkIndexes.length === 2 && compatibleFamilies(milkFoods)
      && sameMilkContainer(milkFoods) && sameCanonicalKey(milkFoods)
      && milkFoods[0].notes != null && milkFoods[0].notes === milkFoods[1].notes
      && rowsShowDistinctContainers(milkFoods)
      && evidencedMilkCount(analysis, milkFoods) < 2) {
    // Two identical AI rows repeating the *same* note about other vessels or
    // both sides of the scene do not independently prove two milk servings.
    // Keep the second row pending, rather than counting it or merging it away.
    return markSuspectedDuplicates(analysis, milkIndexes);
  }
  if (milkIndexes.length >= 2 && compatibleFamilies(milkFoods)) {
    const rowsAreDistinct = rowsShowDistinctContainers(milkFoods);
    const mealOnlySeparate = mealOnlySuggestsAnotherContainer(analysis, milkFoods);
    const uncertain = uncertainSameServing(analysis, milkFoods);
    const negated = negatedDistinctServing(analysis, milkFoods);
    if (
      !rowsAreDistinct &&
      !mealOnlySeparate &&
      !uncertain &&
      !negated &&
      sameMilkContainer(milkFoods) &&
      (explicitlySameServing(analysis, milkFoods) || sameCanonicalKey(milkFoods))
    ) {
      return mergeMilkRows(analysis, milkIndexes, milkFoods);
    }
    if (!rowsAreDistinct && !negated) {
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
