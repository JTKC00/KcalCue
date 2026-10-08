import type { FoodEstimate, FoodIdentityLevel } from "@/lib/domain/food-analysis";
import { isCompositeIdentity } from "./canonical";
import { NUTRITION_COVERAGE_REASONS } from "./coverage-reason";
import { LocalNutritionProvider } from "./local-provider";
import { localNutritionProfiles } from "./local-data";
import {
  compiledDishTemplates,
  pilotFamilyDefinitions,
  type PilotFamilyId,
} from "./recipe-templates";
import { NutritionService } from "./service";
import type {
  MealCoverage,
  NutritionCoverageReason,
  NutritionMatch,
  NutritionMatchType,
} from "./types";

/**
 * Appendix A of the nutrition-catalog research (draft PR #117, commit c9d4a1a8).
 * Dish rows use identityLevel "dish"; ingredient rows use "ingredient".
 * displayName and normalizedName are both the Chinese name. Portion is 100 g.
 */
export const APPENDIX_A_DISHES = [
  "碟頭飯",
  "叉燒碟頭飯",
  "午餐便當",
  "日式便當",
  "燒鵝飯",
  "油雞飯",
  "脆皮燒肉飯",
  "白切雞飯",
  "海南雞飯",
  "豬扒飯",
  "雞扒飯",
  "煎蛋飯",
  "梅菜扣肉飯",
  "滷肉飯",
  "排骨飯",
  "魚香茄子飯",
  "麻婆豆腐飯",
  "牛肉飯",
  "親子丼",
  "牛丼",
  "石鍋拌飯",
  "乾炒牛河",
  "星洲炒米",
  "車仔麵",
  "牛腩麵",
  "鮮蝦雲吞麵",
  "餐蛋麵",
  "冬蔭功湯",
  "拉麵",
  "擔擔麵",
  "炸醬麵",
  "陽春麵",
  "牛肉麵",
  "米線",
  "河粉",
  "西多士",
  "菠蘿包",
  "叉燒包",
  "蛋撻",
  "腸仔蛋",
  "糯米雞",
  "燒賣",
  "蝦餃",
  "小籠包",
  "春卷",
  "壽司拼盤",
  "壽司",
  "火鍋",
  "漢堡",
  "三文治",
  "肉醬意粉",
  "魚柳薯條",
] as const;

export const APPENDIX_A_INGREDIENTS = [
  "果汁",
  "凍檸茶",
  "油條",
  "西蘭花",
  "牛油果",
  "蝦仁",
  "蒸魚",
  "雞翼",
  "午餐肉",
  "芝士",
  "豆漿",
  "燕麥",
  "乳酪",
] as const;

export interface CoverageBenchmarkFood {
  name: string;
  identityLevel: FoodIdentityLevel;
}

export interface FalseMatchProbe {
  id: string;
  displayName: string;
  normalizedName: string;
  identityLevel: FoodIdentityLevel;
  rule: string;
  knownFalseConfidentMatch: boolean;
  note: string;
  violates: (match: NutritionMatch) => boolean;
}

export const FALSE_MATCH_PROBES: readonly FalseMatchProbe[] = [
  {
    id: "soy-milk",
    displayName: "豆漿",
    normalizedName: "soy milk",
    identityLevel: "ingredient",
    rule: "不得配對 whole-milk",
    knownFalseConfidentMatch: false,
    note: "PR #118 已合併。soy milk 不再配到全脂奶。",
    violates: (match) => match.includedInTotal && match.profile?.id === "whole-milk",
  },
  {
    id: "oat-milk",
    displayName: "燕麥奶",
    normalizedName: "oat milk",
    identityLevel: "ingredient",
    rule: "不得配對 whole-milk",
    knownFalseConfidentMatch: false,
    note: "PR #118 已合併。oat milk 不再配到全脂奶。",
    violates: (match) => match.includedInTotal && match.profile?.id === "whole-milk",
  },
  {
    id: "almond-milk",
    displayName: "杏仁奶",
    normalizedName: "almond milk",
    identityLevel: "ingredient",
    rule: "不得配對 whole-milk",
    knownFalseConfidentMatch: false,
    note: "PR #118 已合併。almond milk 不再配到全脂奶。",
    violates: (match) => match.includedInTotal && match.profile?.id === "whole-milk",
  },
  {
    id: "char-siu-rice-not-ingredient",
    displayName: "叉燒飯",
    normalizedName: "叉燒飯",
    identityLevel: "dish",
    rule: "不得拆成單一食材（白飯或其他非組合菜 profile）",
    knownFalseConfidentMatch: false,
    note: "中文「叉燒飯」維持燒味飯組合菜 profile，不是白飯。",
    violates: (match) =>
      match.includedInTotal && match.profile != null && match.profile.composite !== true,
  },
  {
    id: "chicken-breast-salad-not-creamy",
    displayName: "雞胸沙拉",
    normalizedName: "雞胸沙拉",
    identityLevel: "dish",
    rule: "不得落到 creamy-salad",
    knownFalseConfidentMatch: false,
    note: "維持瘦身 profile protein-vegetable-salad。",
    violates: (match) => match.profile?.id === "creamy-salad",
  },
  {
    id: "caesar-salad-creamy",
    displayName: "凱撒沙律",
    normalizedName: "凱撒沙律",
    identityLevel: "dish",
    rule: "必須配對 creamy-salad",
    knownFalseConfidentMatch: false,
    note: "PR #118 的高脂沙律。計入 creamy-salad 是對的，不是錯誤高信心。",
    violates: (match) => match.includedInTotal && match.profile?.id !== "creamy-salad",
  },
  {
    id: "char-siu-rice-plate",
    displayName: "叉燒碟頭飯",
    normalizedName: "char siu rice plate",
    identityLevel: "dish",
    rule: "英文前綴 char siu rice 不得配對 siu-mei-rice",
    knownFalseConfidentMatch: false,
    note: "N1 把叉燒碟頭飯收到 rice-plate。N2 用碟頭飯模板計算，profile 不是 siu-mei-rice。",
    violates: (match) => match.includedInTotal && match.profile?.id === "siu-mei-rice",
  },
  {
    id: "plain-noodle-soup",
    displayName: "陽春麵",
    normalizedName: "plain noodle soup",
    identityLevel: "dish",
    rule: "英文鍵 noodle soup 不得配對 noodle-soup",
    knownFalseConfidentMatch: false,
    note: "N1 把陽春麵收到茶餐廳麵。N2 用茶餐廳麵模板計算，profile 不是 noodle-soup。",
    violates: (match) => match.includedInTotal && match.profile?.id === "noodle-soup",
  },
  {
    id: "sesame-dressing-not-lean",
    displayName: "雞胸胡麻醬沙律",
    normalizedName: "chicken breast salad with sesame dressing",
    identityLevel: "dish",
    rule: "胡麻醬不得落到 protein-vegetable-salad",
    knownFalseConfidentMatch: false,
    note: "胡麻醬沒有營養 profile。原因碼 DISH_KNOWN_NO_PROFILE，畫面仍是暫未能計算。醬量未定，這次不加沙律醬模板。",
    violates: (match) => match.profile?.id === "protein-vegetable-salad",
  },
  {
    id: "vinaigrette-not-lean",
    displayName: "油醋汁沙律",
    normalizedName: "vinaigrette salad",
    identityLevel: "dish",
    rule: "油醋汁不得落到 protein-vegetable-salad",
    knownFalseConfidentMatch: false,
    note: "油醋汁沒有營養 profile。原因碼 DISH_KNOWN_NO_PROFILE，畫面仍是暫未能計算。醬量未定，這次不加沙律醬模板。",
    violates: (match) => match.profile?.id === "protein-vegetable-salad",
  },
  {
    id: "thousand-island-not-lean",
    displayName: "千島醬沙律",
    normalizedName: "thousand island salad",
    identityLevel: "dish",
    rule: "千島醬不得落到 protein-vegetable-salad",
    knownFalseConfidentMatch: false,
    note: "千島醬走 creamy-salad，不是 60–160 的瘦身沙律。",
    violates: (match) => match.profile?.id === "protein-vegetable-salad",
  },
  {
    id: "egg-yolk-sauce-not-lean",
    displayName: "蛋黃醬沙律",
    normalizedName: "mayonnaise salad",
    identityLevel: "dish",
    rule: "蛋黃醬不得落到 protein-vegetable-salad",
    knownFalseConfidentMatch: false,
    note: "蛋黃醬走 creamy-salad。",
    violates: (match) => match.profile?.id === "protein-vegetable-salad",
  },
];

export interface ResolvedCoverageItem {
  name: string;
  identityLevel: FoodIdentityLevel;
  canonicalName: string;
  compositeIdentity: boolean;
  coverage: MealCoverage;
  includedInTotal: boolean;
  matchType: NutritionMatchType;
  profileId: string | null;
  profileCanonicalName: string | null;
  profileComposite: boolean | null;
  coverageReason: NutritionCoverageReason | null;
  userFacingReason: string | null;
  falseConfidentMatch: boolean;
  dishId: string | null;
  familyId: string | null;
  knownIdentity: boolean;
  hasNutritionProfile: boolean;
}

export interface FalseMatchProbeResult {
  id: string;
  displayName: string;
  normalizedName: string;
  identityLevel: FoodIdentityLevel;
  rule: string;
  knownFalseConfidentMatch: boolean;
  note: string;
  violation: boolean;
  includedInTotal: boolean;
  profileId: string | null;
  profileCanonicalName: string | null;
  canonicalName: string;
  coverage: MealCoverage;
  coverageReason: NutritionCoverageReason | null;
  userFacingReason: string | null;
}

export interface CoverageRate {
  numerator: number;
  denominator: number;
  percent: string;
}

export interface PilotDishReport {
  dishId: string;
  displayName: string;
  familyId: PilotFamilyId;
  familyTitle: string;
  inBenchmark: boolean;
  rangeRatio: number;
  needsFollowUp: boolean;
  complete: boolean;
  caloriesPer100g: { min: number; max: number };
  servingCalories: { min: number; max: number };
  feasibleGrams: { min: number; max: number };
  components: Array<{
    label: string;
    sourceIds: string[];
    grams: { min: number; max: number };
  }>;
  sanity: {
    sourceId: string;
    sourceName: string;
    kcalPer100g: number;
    insideRange: boolean;
    note: string;
  };
}

export interface PilotFamilyReport {
  id: PilotFamilyId;
  title: string;
  selectionReason: string;
  benchmarkDishes: number;
  completeBenchmarkDishes: number;
  followUpDishes: number;
  blockedDishes: number;
}

export interface PilotCoverage {
  gate: "N2";
  comparedWith: "Gate N1 / PR #120";
  n1: {
    safeCoverage: "1/65";
    safePercent: "1.5%";
    falseConfidentMatch: "0/12";
    falseConfidentPercent: "0.0%";
    profileCoverage: "1/65";
    dishKnownNoProfile: 51;
    complete: 1;
  };
  families: PilotFamilyReport[];
  familyBenchmarkCounts: Array<{ familyId: string; benchmarkDishes: number }>;
  dishes: PilotDishReport[];
  rangeDistribution: {
    upTo2: number;
    above2To2_5: number;
    above2_5To3: number;
    above3: number;
  };
  preservedProfiles: Array<{ id: string; caloriesPer100g: { min: number; max: number } }>;
}

export interface NutritionCoverageReport {
  benchmarkCount: number;
  dishCount: number;
  ingredientCount: number;
  portionGrams: 100;
  pipeline: "dish identity → canonicalizeFood → resolveNutritionMatch → calculateMealNutrition";
  network: "none";
  coverage: Record<MealCoverage, number>;
  reasons: Record<NutritionCoverageReason, number>;
  safeCoverageRate: CoverageRate;
  falseConfidentMatchRate: CoverageRate;
  /** Benchmark rows whose name resolved to a curated dish identity. */
  identityCoverage: CoverageRate;
  /** Benchmark rows whose identity already has a nutrition profile. */
  profileCoverage: CoverageRate;
  pilot: PilotCoverage;
  items: ResolvedCoverageItem[];
  probes: FalseMatchProbeResult[];
}

const PRESERVED_PROFILE_IDS = [
  "siu-mei-rice",
  "noodle-soup",
  "congee",
  "claypot-rice",
  "milk-tea",
  "rice-noodle-roll",
] as const;

const BENCHMARK_DISH_NAMES = new Set<string>(APPENDIX_A_DISHES);

export function appendixAFoods(): CoverageBenchmarkFood[] {
  return [
    ...APPENDIX_A_DISHES.map((name) => ({ name, identityLevel: "dish" as const })),
    ...APPENDIX_A_INGREDIENTS.map((name) => ({
      name,
      identityLevel: "ingredient" as const,
    })),
  ];
}

export function benchmarkFoodEstimate(
  displayName: string,
  normalizedName: string,
  identityLevel: FoodIdentityLevel,
): FoodEstimate {
  return {
    displayName,
    normalizedName,
    identityLevel,
    portionMin: 100,
    portionMax: 100,
    unit: "g",
    recognitionConfidence: 0.9,
    portionConfidence: 0.8,
    uncertaintyReasons: [],
  };
}

export function formatRatePercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "0.0%";
  const tenths = Math.round((numerator * 1000) / denominator);
  const whole = Math.trunc(tenths / 10);
  const fraction = Math.abs(tenths % 10);
  return `${whole}.${fraction}%`;
}

function emptyCoverage(): Record<MealCoverage, number> {
  return { complete: 0, partial: 0, insufficient: 0, none: 0 };
}

function emptyReasons(): Record<NutritionCoverageReason, number> {
  return {
    UNKNOWN_DISH: 0,
    DISH_KNOWN_NO_PROFILE: 0,
    COMPOSITE_UNSUPPORTED: 0,
    TYPE_MISMATCH: 0,
    UNIT_CONVERSION_MISSING: 0,
    AMBIGUOUS_MATCH: 0,
    INSUFFICIENT_COVERAGE: 0,
  };
}

function rate(numerator: number, denominator: number): CoverageRate {
  return {
    numerator,
    denominator,
    percent: formatRatePercent(numerator, denominator),
  };
}

interface PipelineHit {
  match: NutritionMatch;
  coverage: MealCoverage;
}

function runPipeline(food: FoodEstimate): PipelineHit {
  const provider = new LocalNutritionProvider();
  const meal = new NutritionService(provider).calculateMeal([food]);
  const match = meal.foods[0]?.match;
  if (!match) {
    throw new Error(`本地管線沒有回傳配對：${food.displayName}`);
  }
  return { match, coverage: meal.coverage };
}

function describeMatch(
  match: NutritionMatch,
  coverage: MealCoverage,
  falseConfidentMatch: boolean,
  name: string,
  identityLevel: FoodIdentityLevel,
): ResolvedCoverageItem {
  return {
    name,
    identityLevel,
    canonicalName: match.identity.canonicalName,
    compositeIdentity: isCompositeIdentity(match.identity),
    coverage,
    includedInTotal: match.includedInTotal,
    matchType: match.matchType,
    profileId: match.profile?.id ?? null,
    profileCanonicalName: match.profile?.canonicalName ?? null,
    profileComposite: match.profile?.composite ?? null,
    coverageReason: match.coverageReason ?? null,
    userFacingReason: match.reasons[0] ?? null,
    falseConfidentMatch,
    dishId: match.identity.dishId ?? null,
    familyId: match.identity.familyId ?? null,
    knownIdentity: Boolean(match.identity.dishId),
    hasNutritionProfile: match.identity.hasNutritionProfile === true,
  };
}

export function runFalseMatchProbe(probe: FalseMatchProbe): FalseMatchProbeResult {
  const food = benchmarkFoodEstimate(
    probe.displayName,
    probe.normalizedName,
    probe.identityLevel,
  );
  const { match, coverage } = runPipeline(food);
  const violation = probe.violates(match);
  return {
    id: probe.id,
    displayName: probe.displayName,
    normalizedName: probe.normalizedName,
    identityLevel: probe.identityLevel,
    rule: probe.rule,
    knownFalseConfidentMatch: probe.knownFalseConfidentMatch,
    note: probe.note,
    violation,
    includedInTotal: match.includedInTotal,
    profileId: match.profile?.id ?? null,
    profileCanonicalName: match.profile?.canonicalName ?? null,
    canonicalName: match.identity.canonicalName,
    coverage,
    coverageReason: match.coverageReason ?? null,
    userFacingReason: match.reasons[0] ?? null,
  };
}

function benchmarkItemIsFalseConfident(match: NutritionMatch, identityLevel: FoodIdentityLevel): boolean {
  return identityLevel === "dish"
    && match.includedInTotal
    && match.profile != null
    && match.profile.composite !== true;
}

export function buildCoverageReport(): NutritionCoverageReport {
  const foods = appendixAFoods();
  const coverage = emptyCoverage();
  const reasons = emptyReasons();
  const items = foods.map((food) => {
    const estimate = benchmarkFoodEstimate(food.name, food.name, food.identityLevel);
    const { match, coverage: mealCoverage } = runPipeline(estimate);
    coverage[mealCoverage] += 1;
    if (match.coverageReason) reasons[match.coverageReason] += 1;
    const falseConfidentMatch = benchmarkItemIsFalseConfident(match, food.identityLevel);
    return describeMatch(match, mealCoverage, falseConfidentMatch, food.name, food.identityLevel);
  });

  const probes = FALSE_MATCH_PROBES.map((probe) => runFalseMatchProbe(probe));
  const safeComplete = items.filter((item) => item.coverage === "complete" && !item.falseConfidentMatch).length;
  const falseConfidentProbes = probes.filter((probe) => probe.violation).length;

  const report: NutritionCoverageReport = {
    benchmarkCount: foods.length,
    dishCount: APPENDIX_A_DISHES.length,
    ingredientCount: APPENDIX_A_INGREDIENTS.length,
    portionGrams: 100,
    pipeline: "dish identity → canonicalizeFood → resolveNutritionMatch → calculateMealNutrition",
    network: "none",
    coverage,
    reasons,
    safeCoverageRate: rate(safeComplete, foods.length),
    falseConfidentMatchRate: rate(falseConfidentProbes, probes.length),
    identityCoverage: rate(items.filter((item) => item.knownIdentity).length, foods.length),
    profileCoverage: rate(items.filter((item) => item.hasNutritionProfile).length, foods.length),
    pilot: buildPilotCoverage(items),
    items,
    probes,
  };
  assertReportInvariants(report);
  return report;
}

function buildPilotCoverage(items: ResolvedCoverageItem[]): PilotCoverage {
  const benchmarkNames = BENCHMARK_DISH_NAMES;
  const familyCounts = new Map<string, number>();
  for (const item of items) {
    if (item.identityLevel !== "dish" || !item.familyId) continue;
    familyCounts.set(item.familyId, (familyCounts.get(item.familyId) ?? 0) + 1);
  }
  const dishes: PilotDishReport[] = compiledDishTemplates.map((template) => ({
    dishId: template.dishId,
    displayName: template.displayName,
    familyId: template.familyId,
    familyTitle: template.familyTitle,
    inBenchmark: template.aliases.some((alias) => benchmarkNames.has(alias)),
    rangeRatio: template.rangeRatio,
    needsFollowUp: template.needsFollowUp,
    complete: template.complete,
    caloriesPer100g: template.calculation.per100g.calories,
    servingCalories: template.calculation.servingCalories,
    feasibleGrams: template.calculation.feasibleGrams,
    components: template.components.map((component) => ({
      label: component.label,
      sourceIds: component.sourceIds,
      grams: component.grams,
    })),
    sanity: template.sanity,
  }));
  const families = pilotFamilyDefinitions().map((family) => {
    const familyDishes = dishes.filter((dish) => dish.familyId === family.id);
    const benchmarkDishes = items.filter((item) => item.familyId === family.id && item.identityLevel === "dish");
    return {
      id: family.id,
      title: family.title,
      selectionReason: family.selectionReason,
      benchmarkDishes: benchmarkDishes.length,
      completeBenchmarkDishes: benchmarkDishes.filter((item) => item.coverage === "complete").length,
      followUpDishes: familyDishes.filter((dish) => dish.needsFollowUp).length,
      blockedDishes: familyDishes.filter((dish) => !dish.complete).length,
    };
  });
  return {
    gate: "N2",
    comparedWith: "Gate N1 / PR #120",
    n1: {
      safeCoverage: "1/65",
      safePercent: "1.5%",
      falseConfidentMatch: "0/12",
      falseConfidentPercent: "0.0%",
      profileCoverage: "1/65",
      dishKnownNoProfile: 51,
      complete: 1,
    },
    families,
    familyBenchmarkCounts: [...familyCounts.entries()]
      .map(([familyId, benchmarkDishes]) => ({ familyId, benchmarkDishes }))
      .sort((left, right) => right.benchmarkDishes - left.benchmarkDishes || left.familyId.localeCompare(right.familyId)),
    dishes,
    rangeDistribution: {
      upTo2: dishes.filter((dish) => dish.rangeRatio <= 2).length,
      above2To2_5: dishes.filter((dish) => dish.rangeRatio > 2 && dish.rangeRatio <= 2.5).length,
      above2_5To3: dishes.filter((dish) => dish.rangeRatio > 2.5 && dish.rangeRatio <= 3).length,
      above3: dishes.filter((dish) => dish.rangeRatio > 3).length,
    },
    preservedProfiles: PRESERVED_PROFILE_IDS.map((id) => {
      const profile = localNutritionProfiles.find((item) => item.id === id);
      if (!profile) throw new Error(`缺少既有 profile ${id}`);
      return { id, caloriesPer100g: profile.nutrientsPer100g.calories };
    }),
  };
}

function assertReportInvariants(report: NutritionCoverageReport): void {
  const coverageTotal = report.coverage.complete
    + report.coverage.partial
    + report.coverage.insufficient
    + report.coverage.none;
  if (coverageTotal !== report.benchmarkCount) {
    throw new Error(`coverage 合計 ${coverageTotal}，基準 ${report.benchmarkCount}`);
  }
  const reasonTotal = NUTRITION_COVERAGE_REASONS.reduce(
    (sum, reason) => sum + report.reasons[reason],
    0,
  );
  const nonComplete = report.benchmarkCount - report.coverage.complete;
  if (reasonTotal !== nonComplete) {
    throw new Error(`原因碼合計 ${reasonTotal}，未 complete 的項目 ${nonComplete}`);
  }
  for (const item of report.items) {
    if (item.coverage === "complete" && item.coverageReason !== null) {
      throw new Error(`${item.name} 已 complete 仍帶原因碼`);
    }
    if (item.coverage !== "complete" && item.coverageReason === null) {
      throw new Error(`${item.name} 未 complete 但沒有原因碼`);
    }
    if (item.knownIdentity !== Boolean(item.dishId)) {
      throw new Error(`${item.name} 的身份標記與 dishId 不一致`);
    }
    if (item.hasNutritionProfile && !item.knownIdentity) {
      throw new Error(`${item.name} 有營養 profile 但沒有菜色身份`);
    }
  }
  if (report.identityCoverage.numerator !== report.items.filter((item) => item.knownIdentity).length) {
    throw new Error("身份覆蓋分子與逐項不一致");
  }
  if (report.profileCoverage.numerator !== report.items.filter((item) => item.hasNutritionProfile).length) {
    throw new Error("profile 覆蓋分子與逐項不一致");
  }
  for (const dish of report.pilot.dishes) {
    if (dish.rangeRatio > 2.5 && !dish.needsFollowUp) {
      throw new Error(`${dish.displayName} 的 R 大於 2.5 但沒有標記追問`);
    }
    if (dish.rangeRatio > 3 && dish.complete) {
      throw new Error(`${dish.displayName} 的 R 大於 3 仍標記完成`);
    }
    if (!dish.feasibleGrams || dish.feasibleGrams.max < dish.feasibleGrams.min) {
      throw new Error(`${dish.displayName} 的可行總重無效`);
    }
    const benchmarkItem = report.items.find((item) => item.dishId === dish.dishId);
    if (dish.inBenchmark && !benchmarkItem) {
      throw new Error(`${dish.displayName} 標記在基準內但找不到對應項`);
    }
    if (benchmarkItem && dish.complete && benchmarkItem.coverage !== "complete") {
      throw new Error(`${dish.displayName} 模板已完成但基準未計入`);
    }
    if (benchmarkItem && !dish.complete && benchmarkItem.coverageReason !== "DISH_KNOWN_NO_PROFILE") {
      throw new Error(`${dish.displayName} 模板未完成時應維持 DISH_KNOWN_NO_PROFILE`);
    }
    if (benchmarkItem?.coverage === "complete" && benchmarkItem.profileComposite !== true) {
      throw new Error(`${dish.displayName} 完成時必須仍是組合菜 profile`);
    }
  }
}

export function formatCoverageBaselineMarkdown(report: NutritionCoverageReport): string {
  const completeNames = report.items
    .filter((item) => item.coverage === "complete")
    .map((item) => item.name);
  const unsupported = report.items
    .filter((item) => item.coverageReason === "COMPOSITE_UNSUPPORTED")
    .map((item) => `${item.name}（${item.canonicalName}）`);
  const knownFalse = report.probes.filter((probe) => probe.knownFalseConfidentMatch);
  const passing = report.probes.filter((probe) => !probe.violation);
  const knownDishes = report.items.filter((item) => item.identityLevel === "dish" && item.knownIdentity);
  const lines = [
    "# 營養覆蓋基準（Gate N2）",
    "",
    "這是 Gate N2 的基準，疊在 Gate N1（PR #120，分支 `cursor/nutrition-coverage-n1-2823`）之上。程式先對菜色身份表做精確別名，再跑 `canonicalizeFood`、`resolveNutritionMatch`、`calculateMealNutrition`。試點家族用食譜模板編成組合菜 profile。沒有呼叫 USDA live client、OpenAI，也沒有讀正式環境餐點。Vision 不參與，也不提供 kcal。模板數字來自 USDA SR Legacy（2018-04，CC0），不是模型估計。",
    "",
    `Gate N1（#120）的對照：安全覆蓋 ${report.pilot.n1.safeCoverage}（${report.pilot.n1.safePercent}），profile 覆蓋 ${report.pilot.n1.profileCoverage}，錯誤高信心配對 ${report.pilot.n1.falseConfidentMatch}（${report.pilot.n1.falseConfidentPercent}），\`DISH_KNOWN_NO_PROFILE\` ${report.pilot.n1.dishKnownNoProfile}，complete ${report.pilot.n1.complete}。身份覆蓋當時已是 52/65。`,
    "",
    "Gate N0 的對照：安全覆蓋 1/65（1.5%），錯誤高信心配對 2/8（25.0%）。當時還沒有分開的身份覆蓋。",
    "",
    "65 個名稱來自營養目錄研究附錄 A（Draft PR #117，commit `c9d4a1a8`）。碟上的菜是 `identityLevel: \"dish\"`，單獨食物是 `\"ingredient\"`。`displayName` 與 `normalizedName` 都是該中文名，份量 100 g。",
    "",
    "## 指標",
    "",
    "**餐覆蓋**把每一個名稱單獨當成一餐。`complete` 是該項有計入餐總數。`none` 是沒有任何項目計入。`insufficient` 是有計入但低於 75%。`partial` 是至少 75% 但不是全部。單項餐只會是 `complete` 或 `none`。",
    "",
    "**身份覆蓋**是 65 個名稱裡，精確對上菜色身份表（有 `dishId`）的項數。**profile 覆蓋**是這些身份裡已經接上營養 profile 的項數，包括 N2 食譜模板。知道菜名而沒有 profile 的項目維持不計入。",
    "",
    "**原因碼**只在該項沒有 `complete` 時出現，欄位是可選的 `coverageReason`。使用者看到的句子仍是 `reasons`，總數與已儲存餐點的必填形狀不變。舊配對沒有這個欄位，仍可通過 `nutritionMatchResponseSchema`。新代碼也是可選的，舊紀錄不必補上。",
    "",
    "| 原因碼 | 意義 |",
    "|---|---|",
    "| `UNKNOWN_DISH` | 組合菜身份只落到通用桶（`unknown`、`mixed-dish`、`rice-dish`、`noodle-dish`、`bread-dish`），目錄沒有這道菜的 profile，也不拆成單一食材。 |",
    "| `DISH_KNOWN_NO_PROFILE` | 菜色身份表已經認得這道菜，但還沒有營養 profile，因此不計算。 |",
    "| `COMPOSITE_UNSUPPORTED` | 已經辨成特定組合菜 canonical，但該 canonical 不在身份表的「已知但無 profile」路徑，而且沒有整道菜 profile。 |",
    "| `TYPE_MISMATCH` | 候選 profile 與菜式／食材層級不相容。 |",
    "| `UNIT_CONVERSION_MISSING` | 已經配到食物，但這個單位沒有可靠的克重換算。 |",
    "| `AMBIGUOUS_MATCH` | 兩個不同身份或 canonical 的差距太小，或中英文指向互不從屬的菜，為免假裝精準而不配對。 |",
    "| `INSUFFICIENT_COVERAGE` | 非組合菜沒有足夠參考資料，或只有低信心的粗略配對，因此不計入總數。 |",
    "",
    "**安全覆蓋率（Safe Coverage Rate）** = 基準裡餐覆蓋為 `complete`、而且不是錯誤高信心配對的項數 / 65。錯誤高信心配對指：`identityLevel` 為 dish，卻計入一個非組合菜 profile。中文名樣本裡的「未計入」不是錯誤高信心。",
    "",
    "**錯誤高信心配對率（False Confident Match Rate）** = 負向探針裡，違反該探針規則的項數 / 探針數。探針不混進 65 個中文名的覆蓋計數。",
    "",
    "## 基準結果",
    "",
    `| 覆蓋 | 數量 |`,
    `|---|---:|`,
    `| 樣本 | ${report.benchmarkCount} |`,
    `| dish | ${report.dishCount} |`,
    `| ingredient | ${report.ingredientCount} |`,
    `| complete | ${report.coverage.complete} |`,
    `| insufficient | ${report.coverage.insufficient} |`,
    `| none | ${report.coverage.none} |`,
    `| partial | ${report.coverage.partial} |`,
    "",
    `complete 的名稱：${completeNames.join("、") || "（無）"}。`,
    "",
    `安全覆蓋率：${report.safeCoverageRate.numerator}/${report.safeCoverageRate.denominator}（${report.safeCoverageRate.percent}）。`,
    "",
    `身份覆蓋：${report.identityCoverage.numerator}/${report.identityCoverage.denominator}（${report.identityCoverage.percent}）。其中附錄 A 的菜色有身份的是 ${knownDishes.length}/${report.dishCount}。`,
    "",
    `profile 覆蓋：${report.profileCoverage.numerator}/${report.profileCoverage.denominator}（${report.profileCoverage.percent}）。`,
    "",
    "| 原因碼 | 數量 |",
    "|---|---:|",
    ...NUTRITION_COVERAGE_REASONS.map((reason) => `| \`${reason}\` | ${report.reasons[reason]} |`),
    "",
    `特定組合菜但沒有 profile（\`COMPOSITE_UNSUPPORTED\`）：${unsupported.join("、") || "（無）"}。`,
    "",
    "逐項 canonical、profile、原因碼與使用者句子見 [nutrition-coverage-baseline.json](nutrition-coverage-baseline.json)。",
    "",
    "## 負向探針",
    "",
    `錯誤高信心配對率：${report.falseConfidentMatchRate.numerator}/${report.falseConfidentMatchRate.denominator}（${report.falseConfidentMatchRate.percent}）。`,
    "",
    "| 探針 | 顯示名 | normalizedName | 規則 | 計入 | profile | 錯誤高信心 |",
    "|---|---|---|---|---|---|---|",
    ...report.probes.map((probe) => `| \`${probe.id}\` | ${probe.displayName} | \`${probe.normalizedName}\` | ${probe.rule} | ${probe.includedInTotal ? "是" : "否"} | ${probe.profileId ?? "—"} | ${probe.violation ? "是" : "否"} |`),
    "",
    "### 已知錯誤高信心",
    "",
    ...(knownFalse.length > 0
      ? knownFalse.map((probe) => `- \`${probe.id}\`：${probe.displayName} / \`${probe.normalizedName}\` 現時計入 \`${probe.profileId ?? "—"}\`。${probe.note}`)
      : ["- （無）"]),
    "",
    "### 已通過的探針",
    "",
    ...passing.map((probe) => `- \`${probe.id}\`：${probe.displayName} / \`${probe.normalizedName}\` → \`${probe.profileId ?? "—"}\`。${probe.note}`),
    "",
    ...formatPilotSections(report),
    "## 重現",
    "",
    "`npm run coverage:report` 只跑上述本地管線。輸出應與這份 Markdown 及旁邊的 JSON 一致。",
    "",
    "要覆寫基準檔，執行 `UPDATE_COVERAGE_BASELINE=1 npm run coverage:report`。它會寫入 `docs/research/nutrition-coverage-baseline.json` 和這份 Markdown。沒有該環境變數時，測試只核對已提交的檔案，不會寫入。",
    "",
  ];
  return `${lines.join("\n")}`;
}

function formatPilotSections(report: NutritionCoverageReport): string[] {
  const pilot = report.pilot;
  const followUp = pilot.dishes.filter((dish) => dish.needsFollowUp);
  const blocked = pilot.dishes.filter((dish) => !dish.complete);
  return [
    "## 試點家族",
    "",
    "五個家族按附錄 A 的菜數來選。菜數打平時，選香港日常菜單裡更常出現的一族。燒味飯和粥已經有 profile，而且不在這 65 個名稱裡，這次不改它們的總數。",
    "",
    "| 家族 | 基準菜數 | 納入基準 | 需要追問 | R>3 未完成 | 選擇原因 |",
    "|---|---:|---:|---:|---:|---|",
    ...pilot.families.map((family) =>
      `| ${family.title}（\`${family.id}\`） | ${family.benchmarkDishes} | ${family.completeBenchmarkDishes} | ${family.followUpDishes} | ${family.blockedDishes} | ${family.selectionReason} |`,
    ),
    "",
    "全部基準菜的家族菜數：",
    "",
    "| 家族 | 基準菜數 |",
    "|---|---:|",
    ...pilot.familyBenchmarkCounts.map((family) => `| \`${family.familyId}\` | ${family.benchmarkDishes} |`),
    "",
    "## 與 N1 對照",
    "",
    "| 指標 | N1（#120） | N2 |",
    "|---|---:|---:|",
    `| 安全覆蓋 | ${pilot.n1.safeCoverage}（${pilot.n1.safePercent}） | ${report.safeCoverageRate.numerator}/${report.safeCoverageRate.denominator}（${report.safeCoverageRate.percent}） |`,
    `| profile 覆蓋 | ${pilot.n1.profileCoverage} | ${report.profileCoverage.numerator}/${report.profileCoverage.denominator}（${report.profileCoverage.percent}） |`,
    `| 錯誤高信心配對 | ${pilot.n1.falseConfidentMatch}（${pilot.n1.falseConfidentPercent}） | ${report.falseConfidentMatchRate.numerator}/${report.falseConfidentMatchRate.denominator}（${report.falseConfidentMatchRate.percent}） |`,
    `| \`DISH_KNOWN_NO_PROFILE\` | ${pilot.n1.dishKnownNoProfile} | ${report.reasons.DISH_KNOWN_NO_PROFILE} |`,
    `| complete | ${pilot.n1.complete} | ${report.coverage.complete} |`,
    "",
    "R 是每道菜每 100 g 熱量上限除以下限，也就是一份參考份量的熱量比。R > 2.5 會在食物卡顯示追問，請使用者補充配料或份量，這次仍納入計算。R > 3 不標記完成，維持 `DISH_KNOWN_NO_PROFILE`。新 profile 的 R ≥ 2 時，配對信心維持中等。手動預設份量是 100–150 g，顯示出來的 kcal 比會再乘上這段份量，所以可以高過每 100 g 的 R。",
    "",
    "| R | 菜數 |",
    "|---|---:|",
    `| ≤ 2 | ${pilot.rangeDistribution.upTo2} |`,
    `| > 2 且 ≤ 2.5 | ${pilot.rangeDistribution.above2To2_5} |`,
    `| > 2.5 且 ≤ 3 | ${pilot.rangeDistribution.above2_5To3} |`,
    `| > 3 | ${pilot.rangeDistribution.above3} |`,
    "",
    followUp.length > 0
      ? `需要追問：${followUp.map((dish) => `${dish.displayName}（R=${dish.rangeRatio.toFixed(2)}）`).join("、")}。`
      : "需要追問：（無）。",
    "",
    blocked.length > 0
      ? `R > 3、未完成：${blocked.map((dish) => `${dish.displayName}（R=${dish.rangeRatio.toFixed(2)}）`).join("、")}。`
      : "R > 3、未完成：（無）。",
    "",
    "## 每道菜的 R",
    "",
    "| 菜 | 家族 | 基準 | 每 100 g kcal | 一份 kcal | 可行總重 g | R | 追問 | 完成 |",
    "|---|---|---|---:|---:|---:|---:|---|---|",
    ...pilot.dishes.map((dish) =>
      `| ${dish.displayName} | ${dish.familyTitle} | ${dish.inBenchmark ? "是" : "否"} | ${dish.caloriesPer100g.min}–${dish.caloriesPer100g.max} | ${dish.servingCalories.min}–${dish.servingCalories.max} | ${dish.feasibleGrams.min}–${dish.feasibleGrams.max} | ${dish.rangeRatio.toFixed(2)} | ${dish.needsFollowUp ? "是" : "否"} | ${dish.complete ? "是" : "否"} |`,
    ),
    "",
    "每項原料的克數和 FDC id 在 [nutrition-coverage-baseline.json](nutrition-coverage-baseline.json) 的 `pilot.dishes[].components`。",
    "",
    "## 公開點值對照",
    "",
    "對照值只核對數量級。它們是 USDA SR Legacy 的另一列食物，不是這碟的化驗，也不是目錄裡的原料加總。落在範圍外不自動判失敗；表內寫明原因。沒有使用香港食安中心或 Open Food Facts。",
    "",
    "| 菜 | 模板每 100 g | 對照 | 對照 kcal | 落在範圍內 | 說明 |",
    "|---|---:|---|---:|---|---|",
    ...pilot.dishes.map((dish) =>
      `| ${dish.displayName} | ${dish.caloriesPer100g.min}–${dish.caloriesPer100g.max} | ${dish.sanity.sourceName}（\`${dish.sanity.sourceId}\`） | ${dish.sanity.kcalPer100g} | ${dish.sanity.insideRange ? "是" : "否"} | ${dish.sanity.note} |`,
    ),
    "",
    "## 沒有改動的既有總數",
    "",
    "鮮蝦雲吞麵、雲吞麵、湯麵仍用 `noodle-soup`。叉燒飯、燒味飯仍用 `siu-mei-rice`，但每 100 g 上限由 320 收緊到 210。白粥、皮蛋瘦肉粥仍用 `congee`。其餘列出的 profile 熱量沒有改。",
    "",
    "| profile | 每 100 g kcal |",
    "|---|---:|",
    ...pilot.preservedProfiles.map((profile) =>
      `| \`${profile.id}\` | ${profile.caloriesPer100g.min}–${profile.caloriesPer100g.max} |`,
    ),
    "",
    "行為變化：試點家族裡 R ≤ 3 的菜，由 `DISH_KNOWN_NO_PROFILE` 改為計入 `template:<dishId>`，而且 `composite: true`。叉燒碟頭飯會計入，但不是 `siu-mei-rice`。陽春麵會計入，但不是 `noodle-soup`。其餘家族維持不計算。組合菜不會拆成單一食材。",
    "",
    "## 授權",
    "",
    "這次只用 USDA FoodData Central SR Legacy（2018-04），公有領域／CC0 1.0。台灣食藥署開放資料、日本八訂成分表、加拿大 CNF 的條款仍以研究文件為準，這次沒有匯入，所以沒有觸發它們的顯名義務。香港食安中心營養資料庫只限個人非商業使用，Open Food Facts 是 ODbL，兩者都沒有用。",
    "",
    "## 生產 QA 跟進",
    "",
    "65 個名稱的安全覆蓋、profile 覆蓋、身份覆蓋和錯誤高信心配對沒有因為這次跟進而改變。忌廉通粉、鮮奶和燕麥牛奶粥都不在這 65 個名稱裡。",
    "",
    "只有凍的通粉沙律才接到既有 `creamy-salad`：通粉沙律、macaroni salad，或忌廉通粉同時有沙律／凍食說明。熱食字中英成對：熱食對 hot，粟米忌廉或玉米忌廉對 corn cream，忌廉汁對 cream sauce，焗對 baked 或 gratin，另有熱辣。單是 corn、粟米，或備註「高熱量」，不會把它變成熱食。粟米忌廉通粉、焗忌廉通粉、忌廉汁通粉，以及沒有凍食說明的忌廉通粉，身份是 `cream-macaroni`，原因碼 `DISH_KNOWN_NO_PROFILE`，不計算，也不交給 USDA。目錄下限仍是 63 kcal／100 g（FDC 2706818）。畫面把一份的 kcal 向下取整到 5，所以 100 g 的高脂沙律會顯示 60，而不是 63。份量約 95–98 g 時，未進位的下限大約是 60–62 kcal。這是顯示進位，目錄數字沒有改。",
    "",
    "胡麻醬沙律和油醋汁沙律維持不計算，原因碼是 `DISH_KNOWN_NO_PROFILE`。使用者句子說明還沒有營養 profile。醬量足以把 R 推過 3，而且不在這五個試點家族，所以這次不加模板。",
    "",
    "名稱是牛奶、鮮奶、全脂奶、低脂奶、fresh milk、skim milk 或 low-fat milk，或者這些標籤只多了溫度或分量字（熱、凍、暖、大、細、一杯、hot、iced、cold、warm、small、large、medium、a glass of、a cup of），而該項備註、可見食材、不確定原因，或同一餐的可見證據、餐點備註、餐點不確定說明指向燕麥奶、豆漿或杏仁奶時，不配對 whole-milk。這不是只接受完全一樣的牛奶標籤，也不是名稱裡任意出現牛奶就算。`POST /api/meals` 和 `POST /api/nutrition/resolve` 也不把該項交給 USDA live lookup。牛奶布甸、奶茶、milk tea、牛奶麥片不會因為名稱裡有牛奶就當成牛奶；杏仁片和黃豆也不是植物奶。沒有植物奶或低脂證據時，手動輸入的鮮奶、牛奶和 fresh milk 配對本地全脂奶，所以沒有 USDA key 的 Demo 仍可計算。這是香港鮮奶通常是全脂的產品預設；若那杯其實是沒有標明的低脂奶，熱量可能高估約三成。名稱本身是低脂奶、脫脂奶、簡體脱脂奶、skim milk 或 low-fat milk 時不配全脂奶。本地目錄沒有減脂或低脂奶時維持不計算，並說明原因；若目錄後來有對應項目才用該項。沒有植物奶證據時，手動的低脂標籤仍可交給 USDA。燕麥牛奶粥和麥片加牛奶仍保留乳製奶，餐點備註裡的植物奶不會改這碗粥。",
    "",
    "相片來源不同。項目來自相片，顯示名稱或英文名在去掉溫度、杯子、玻璃、飲品等說法之後仍是牛奶、奶或 milk，而且顯示名稱沒有全脂、低脂、脫脂、鮮奶或植物奶時，一定先顯示種類選項。模型把該項標成菜式、把英文名猜成 whole milk，或在可見證據裡換一種寫法，都不會令選項消失，也不會因此直接配對 USDA 全脂奶。餐點未知說明寫「未能確認是否為牛奶、植物奶或其他白色飲品」只是未能分辨，不是植物奶證據，也不會收起選項。選了全脂牛奶之後，即使模型原本把該項標成菜式或組合菜，也會改為單一全脂奶食材再計算；餐點裡殘留的植物奶字眼不會蓋過這個選擇。低脂同樣只在目錄已有減脂或低脂奶時計算，目前沒有，所以選了也暫不計算。選了其他就收起選項，不另開文字欄。朱古力奶不是這個選項，也不會因此配上全脂奶。手動輸入的鮮奶和牛奶維持全脂預設。同一容器的奶類可以有不同名稱（例如燕麥奶、燕麥飲品、紙盒燕麥奶，或一項泛稱加一項具體）和不同份量，只要沒有第二杯的證據，就併成一項，份量不會相加。合併提示寫在項目自己的欄位，不佔不確定原因的八個位置。",
    "",
    "茶餐廳常餐不放進早餐家族的模板。它是客人選的主菜加飲品，不是西多士、菠蘿包、腸仔蛋或通粉湯。身份是 `cha-chaan-teng-set`，原因碼 `DISH_KNOWN_NO_PROFILE`。蝦餃、鮮蝦餃、水晶蝦餃都對上點心家族的 `har-gow`。火腿通粉繼續用通粉湯模板，因為茶餐廳的火腿通粉是連湯的。",
    "",
    "叉燒飯的每 100 g 上限對齊食譜模板。叉燒碟頭飯原料最高約 186 kcal／100 g，燒鵝飯約 188，脆皮燒肉飯約 205。舊上限 320 在預設 100–150 g 會顯示 170–480 kcal，高過這些以飯為主的組合。上限改為 210，下限維持 170。高脂沙律目錄下限仍是 63；畫面把 100 g 顯示成 60，這是進位，沒有改。",
    "",
  ];
}
