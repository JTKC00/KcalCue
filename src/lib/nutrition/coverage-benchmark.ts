import type { FoodEstimate, FoodIdentityLevel } from "@/lib/domain/food-analysis";
import { isCompositeIdentity } from "./canonical";
import { NUTRITION_COVERAGE_REASONS } from "./coverage-reason";
import { LocalNutritionProvider } from "./local-provider";
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

const CREAMY_OR_HIGH_FAT_SALAD =
  /creamy|caesar|mayo|mayonnaise|凱撒|沙律醬|蛋黃醬|千島/;

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
  /** Draft PR expected to remove this false match. Null when no such PR exists. */
  clearedByDraftPr: 118 | null;
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
    knownFalseConfidentMatch: true,
    clearedByDraftPr: 118,
    note: "英文 token milk 命中全脂奶。中文「豆漿」單獨不會。",
    violates: (match) => match.includedInTotal && match.profile?.id === "whole-milk",
  },
  {
    id: "oat-milk",
    displayName: "燕麥奶",
    normalizedName: "oat milk",
    identityLevel: "ingredient",
    rule: "不得配對 whole-milk",
    knownFalseConfidentMatch: true,
    clearedByDraftPr: 118,
    note: "與豆漿相同的 milk token。",
    violates: (match) => match.includedInTotal && match.profile?.id === "whole-milk",
  },
  {
    id: "almond-milk",
    displayName: "杏仁奶",
    normalizedName: "almond milk",
    identityLevel: "ingredient",
    rule: "不得配對 whole-milk",
    knownFalseConfidentMatch: true,
    clearedByDraftPr: 118,
    note: "與豆漿相同的 milk token。",
    violates: (match) => match.includedInTotal && match.profile?.id === "whole-milk",
  },
  {
    id: "char-siu-rice-not-ingredient",
    displayName: "叉燒飯",
    normalizedName: "叉燒飯",
    identityLevel: "dish",
    rule: "不得拆成單一食材（白飯或其他非組合菜 profile）",
    knownFalseConfidentMatch: false,
    clearedByDraftPr: null,
    note: "中文「叉燒飯」維持燒味飯組合菜 profile，不是白飯。",
    violates: (match) =>
      match.includedInTotal && match.profile != null && match.profile.composite !== true,
  },
  {
    id: "chicken-breast-salad-not-creamy",
    displayName: "雞胸沙拉",
    normalizedName: "雞胸沙拉",
    identityLevel: "dish",
    rule: "不得配對 creamy／高脂沙律 profile",
    knownFalseConfidentMatch: false,
    clearedByDraftPr: null,
    note: "維持瘦身 profile protein-vegetable-salad，與高脂沙律分開。",
    violates: (match) => {
      if (!match.includedInTotal || !match.profile) return false;
      const label = [
        match.profile.id,
        match.profile.canonicalName,
        match.profile.displayName,
        ...match.profile.aliases,
      ].join(" ");
      return CREAMY_OR_HIGH_FAT_SALAD.test(label);
    },
  },
  {
    id: "char-siu-rice-plate",
    displayName: "叉燒碟頭飯",
    normalizedName: "char siu rice plate",
    identityLevel: "dish",
    rule: "英文前綴 char siu rice 不得配對 siu-mei-rice",
    knownFalseConfidentMatch: true,
    clearedByDraftPr: null,
    note: "研究 3.3 的英文前綴撞名。Draft PR #118 不處理這條。",
    violates: (match) => match.includedInTotal && match.profile?.id === "siu-mei-rice",
  },
  {
    id: "plain-noodle-soup",
    displayName: "陽春麵",
    normalizedName: "plain noodle soup",
    identityLevel: "dish",
    rule: "英文鍵 noodle soup 不得配對 noodle-soup",
    knownFalseConfidentMatch: true,
    clearedByDraftPr: null,
    note: "研究 3.3 的英文前綴撞名。Draft PR #118 不處理這條。",
    violates: (match) => match.includedInTotal && match.profile?.id === "noodle-soup",
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
}

export interface FalseMatchProbeResult {
  id: string;
  displayName: string;
  normalizedName: string;
  identityLevel: FoodIdentityLevel;
  rule: string;
  knownFalseConfidentMatch: boolean;
  clearedByDraftPr: 118 | null;
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

export interface NutritionCoverageReport {
  benchmarkCount: number;
  dishCount: number;
  ingredientCount: number;
  portionGrams: 100;
  pipeline: "canonicalizeFood → resolveNutritionMatch → calculateMealNutrition";
  network: "none";
  coverage: Record<MealCoverage, number>;
  reasons: Record<NutritionCoverageReason, number>;
  safeCoverageRate: CoverageRate;
  falseConfidentMatchRate: CoverageRate;
  items: ResolvedCoverageItem[];
  probes: FalseMatchProbeResult[];
}

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
    COMPOSITE_UNSUPPORTED: 0,
    TYPE_MISMATCH: 0,
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
    clearedByDraftPr: probe.clearedByDraftPr,
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
    pipeline: "canonicalizeFood → resolveNutritionMatch → calculateMealNutrition",
    network: "none",
    coverage,
    reasons,
    safeCoverageRate: rate(safeComplete, foods.length),
    falseConfidentMatchRate: rate(falseConfidentProbes, probes.length),
    items,
    probes,
  };
  assertReportInvariants(report);
  return report;
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
  }
}

export function formatCoverageBaselineMarkdown(report: NutritionCoverageReport): string {
  const completeNames = report.items
    .filter((item) => item.coverage === "complete")
    .map((item) => item.name);
  const unsupported = report.items
    .filter((item) => item.coverageReason === "COMPOSITE_UNSUPPORTED")
    .map((item) => `${item.name}（${item.canonicalName}）`);
  const clearedBy118 = report.probes.filter((probe) => probe.clearedByDraftPr === 118);
  const notCleared = report.probes.filter(
    (probe) => probe.knownFalseConfidentMatch && probe.clearedByDraftPr === null,
  );
  const lines = [
    "# 營養覆蓋基準（Gate N0）",
    "",
    "這是 Gate N0 的基準，對照合併 PR #116 之後的本地目錄與 resolver。程式是 `canonicalizeFood`、`resolveNutritionMatch`、`calculateMealNutrition`。沒有呼叫 USDA、OpenAI，也沒有讀正式環境餐點。Vision 不參與，也不提供 kcal。",
    "",
    "65 個名稱來自營養目錄研究附錄 A（Draft PR #117，commit `c9d4a1a8`）。碟上的菜是 `identityLevel: \"dish\"`，單獨食物是 `\"ingredient\"`。`displayName` 與 `normalizedName` 都是該中文名，份量 100 g。",
    "",
    "## 指標",
    "",
    "**餐覆蓋**把每一個名稱單獨當成一餐。`complete` 是該項有計入餐總數。`none` 是沒有任何項目計入。`insufficient` 是有計入但低於 75%。`partial` 是至少 75% 但不是全部。單項餐只會是 `complete` 或 `none`。",
    "",
    "**原因碼**只在該項沒有 `complete` 時出現，欄位是可選的 `coverageReason`。使用者看到的句子仍是 `reasons`，總數與已儲存餐點的必填形狀不變。舊配對沒有這個欄位，仍可通過 `nutritionMatchResponseSchema`。",
    "",
    "| 原因碼 | 意義 |",
    "|---|---|",
    "| `UNKNOWN_DISH` | 組合菜身份只落到通用桶（`unknown`、`mixed-dish`、`rice-dish`、`noodle-dish`、`bread-dish`），目錄沒有這道菜的 profile，也不拆成單一食材。 |",
    "| `COMPOSITE_UNSUPPORTED` | 已經辨成特定組合菜 canonical，但沒有整道菜 profile，因此拒絕退回單一食材。 |",
    "| `TYPE_MISMATCH` | 單位沒有可靠克重換算，或候選 profile 與菜式／食材層級不相容。 |",
    "| `AMBIGUOUS_MATCH` | 兩個不同 canonical 的分數差距小於 12，為免假裝精準而不配對。 |",
    "| `INSUFFICIENT_COVERAGE` | 非組合菜沒有足夠參考資料，或只有低信心的粗略配對，因此不計入總數。 |",
    "",
    "**安全覆蓋率（Safe Coverage Rate）** = 基準裡餐覆蓋為 `complete`、而且不是錯誤高信心配對的項數 / 65。錯誤高信心配對指：`identityLevel` 為 dish，卻計入一個非組合菜 profile。中文名樣本裡的「未計入」不是錯誤高信心。",
    "",
    "**錯誤高信心配對率（False Confident Match Rate）** = 負向探針裡，`includedInTotal` 為 true 且違反該探針規則的項數 / 探針數。已知、本基準不修復的錯誤仍然計入分子。探針不混進 65 個中文名的覆蓋計數，因為那些撞名靠的是英文 `normalizedName`，附錄 A 的量測沒有把它們算進去。",
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
    "| 探針 | 顯示名 | normalizedName | 規則 | 計入 | profile | 錯誤高信心 | #118 預期清除 |",
    "|---|---|---|---|---|---|---|---|",
    ...report.probes.map((probe) => `| \`${probe.id}\` | ${probe.displayName} | \`${probe.normalizedName}\` | ${probe.rule} | ${probe.includedInTotal ? "是" : "否"} | ${probe.profileId ?? "—"} | ${probe.violation ? "是" : "否"} | ${probe.clearedByDraftPr === 118 ? "是" : "否"} |`),
    "",
    "### Draft PR #118 預期清除",
    "",
    ...clearedBy118.map((probe) => `- \`${probe.id}\`：${probe.displayName} / \`${probe.normalizedName}\` 現時計入 \`${probe.profileId ?? "—"}\`。${probe.note}`),
    "",
    "### 已知錯誤高信心，#118 不清除",
    "",
    ...notCleared.map((probe) => `- \`${probe.id}\`：${probe.displayName} / \`${probe.normalizedName}\` 現時計入 \`${probe.profileId ?? "—"}\`。${probe.note}`),
    "",
    "通過的負向規則（不計入分子）：中文「叉燒飯」不得變成白飯；「雞胸沙拉」不得配到 creamy／高脂沙律。後者在這份基準已經是 `protein-vegetable-salad`，不是高脂 profile。",
    "",
    "## 重現",
    "",
    "`npm run coverage:report` 只跑上述本地管線。輸出應與這份 Markdown 及旁邊的 JSON 一致。",
    "",
  ];
  return `${lines.join("\n")}`;
}
