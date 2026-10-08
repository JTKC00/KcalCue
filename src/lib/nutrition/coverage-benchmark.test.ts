import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

import { COMPOSITE_GENERIC_FALLBACK_REASON } from "./compatibility";
import {
  APPENDIX_A_DISHES,
  APPENDIX_A_INGREDIENTS,
  FALSE_MATCH_PROBES,
  appendixAFoods,
  benchmarkFoodEstimate,
  buildCoverageReport,
  formatCoverageBaselineMarkdown,
  runFalseMatchProbe,
} from "./coverage-benchmark";
import { NUTRITION_COVERAGE_REASONS } from "./coverage-reason";
import { calculateFoodNutrition } from "./calculation";
import { LocalNutritionProvider } from "./local-provider";
import { nutritionMatchResponseSchema } from "./response-schema";

function withoutCoverageReason<T extends { coverageReason?: string }>(match: T): Omit<T, "coverageReason"> {
  const copy = { ...match };
  delete copy.coverageReason;
  return copy;
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const jsonPath = path.join(root, "docs/research/nutrition-coverage-baseline.json");
const markdownPath = path.join(root, "docs/research/nutrition-coverage-baseline.md");

describe("nutrition coverage benchmark", () => {
  it("keeps the Appendix A list at 52 dishes and 13 ingredients", () => {
    expect(new Set(APPENDIX_A_DISHES).size).toBe(APPENDIX_A_DISHES.length);
    expect(new Set(APPENDIX_A_INGREDIENTS).size).toBe(APPENDIX_A_INGREDIENTS.length);
    expect(APPENDIX_A_DISHES).toHaveLength(52);
    expect(APPENDIX_A_INGREDIENTS).toHaveLength(13);
    expect(appendixAFoods()).toHaveLength(65);
    expect(appendixAFoods().filter((food) => food.identityLevel === "dish")).toHaveLength(52);
    expect(appendixAFoods().filter((food) => food.identityLevel === "ingredient")).toHaveLength(13);
  });

  it("does not call the network while measuring coverage", () => {
    const fetchMock = vi.fn(() => {
      throw new Error("coverage report must not use the network");
    });
    vi.stubGlobal("fetch", fetchMock);
    const report = buildCoverageReport();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(report.network).toBe("none");
    expect(report.benchmarkCount).toBe(65);
    vi.unstubAllGlobals();
  });

  it("matches the committed baseline", () => {
    const report = buildCoverageReport();
    const markdown = formatCoverageBaselineMarkdown(report);
    if (process.env.UPDATE_COVERAGE_BASELINE === "1") {
      writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
      writeFileSync(markdownPath, markdown);
    }
    if (process.env.npm_lifecycle_event === "coverage:report") {
      process.stdout.write(markdown);
    }
    expect(JSON.parse(readFileSync(jsonPath, "utf8"))).toEqual(report);
    expect(readFileSync(markdownPath, "utf8")).toBe(markdown);
  });

  it("records known false confident matches and passes the rules that already hold", () => {
    const results = FALSE_MATCH_PROBES.map((probe) => ({
      probe,
      result: runFalseMatchProbe(probe),
    }));

    for (const { probe, result } of results) {
      expect(result.violation, probe.id).toBe(probe.knownFalseConfidentMatch);
    }

    expect(results.filter(({ result }) => result.violation).map(({ result }) => result.id)).toEqual([
      "char-siu-rice-plate",
      "plain-noodle-soup",
    ]);

    const charSiu = results.find(({ probe }) => probe.id === "char-siu-rice-not-ingredient")?.result;
    expect(charSiu?.includedInTotal).toBe(true);
    expect(charSiu?.profileId).toBe("siu-mei-rice");
    expect(charSiu?.profileCanonicalName).not.toBe("rice");
    expect(charSiu?.violation).toBe(false);

    const salad = results.find(({ probe }) => probe.id === "chicken-breast-salad-not-creamy")?.result;
    expect(salad?.includedInTotal).toBe(true);
    expect(salad?.profileId).toBe("protein-vegetable-salad");
    expect(salad?.profileId).not.toBe("creamy-salad");
    expect(salad?.violation).toBe(false);

    const caesar = results.find(({ probe }) => probe.id === "caesar-salad-creamy")?.result;
    expect(caesar?.includedInTotal).toBe(true);
    expect(caesar?.profileId).toBe("creamy-salad");
    expect(caesar?.violation).toBe(false);

    for (const id of ["soy-milk", "oat-milk", "almond-milk"] as const) {
      const milk = results.find(({ probe }) => probe.id === id)?.result;
      expect(milk?.includedInTotal).toBe(false);
      expect(milk?.profileId).not.toBe("whole-milk");
      expect(milk?.violation).toBe(false);
      expect(milk?.knownFalseConfidentMatch).toBe(false);
    }

    const plate = results.find(({ probe }) => probe.id === "char-siu-rice-plate")?.result;
    expect(plate?.profileId).toBe("siu-mei-rice");
    expect(plate?.knownFalseConfidentMatch).toBe(true);
    const plainSoup = results.find(({ probe }) => probe.id === "plain-noodle-soup")?.result;
    expect(plainSoup?.profileId).toBe("noodle-soup");
    expect(plainSoup?.knownFalseConfidentMatch).toBe(true);
  });

  it("assigns a reason code without changing user-facing copy or totals", () => {
    const provider = new LocalNutritionProvider();
    const dish = benchmarkFoodEstimate("碟頭飯", "碟頭飯", "dish");
    const dishMatch = provider.resolve(dish);
    expect(dishMatch.includedInTotal).toBe(false);
    expect(dishMatch.coverageReason).toBe("UNKNOWN_DISH");
    expect(dishMatch.reasons[0]).toBe(COMPOSITE_GENERIC_FALLBACK_REASON);
    expect(dishMatch.profile).toBeNull();

    const ingredient = benchmarkFoodEstimate("西蘭花", "西蘭花", "ingredient");
    const ingredientMatch = provider.resolve(ingredient);
    expect(ingredientMatch.coverageReason).toBe("INSUFFICIENT_COVERAGE");
    expect(ingredientMatch.reasons[0]).toBe("未有足夠可靠的營養參考資料可以配對。");
    expect(ingredientMatch.profile?.id).not.toBe("whole-milk");

    const soy = benchmarkFoodEstimate("豆漿", "豆漿", "ingredient");
    const soyMatch = provider.resolve(soy);
    expect(soyMatch.includedInTotal).toBe(false);
    expect(soyMatch.profile).toBeNull();

    const namedDish = benchmarkFoodEstimate("拉麵", "拉麵", "dish");
    expect(provider.resolve(namedDish).coverageReason).toBe("COMPOSITE_UNSUPPORTED");

    const wings = benchmarkFoodEstimate("雞翼", "chicken wings", "ingredient");
    const wingsMatch = provider.resolve(wings);
    expect(wingsMatch.includedInTotal).toBe(false);
    expect(wingsMatch.coverageReason).toBe("AMBIGUOUS_MATCH");
    expect(wingsMatch.reasons[0]).toBe("找到多個相近但不相同的營養資料，為免假裝精準，暫不自動配對。");

    const banana = benchmarkFoodEstimate("香蕉", "banana", "ingredient");
    const bananaMl = provider.resolve({ ...banana, unit: "ml" });
    expect(bananaMl.includedInTotal).toBe(false);
    expect(bananaMl.coverageReason).toBe("TYPE_MISMATCH");
    expect(bananaMl.reasons[0]).toContain("ml");

    const included = provider.resolve(benchmarkFoodEstimate("鮮蝦雲吞麵", "鮮蝦雲吞麵", "dish"));
    expect(included.includedInTotal).toBe(true);
    expect(included.profile?.id).toBe("noodle-soup");
    expect(included).not.toHaveProperty("coverageReason");

    const calculated = calculateFoodNutrition(dish, dishMatch);
    const withoutReason = calculateFoodNutrition(dish, withoutCoverageReason(dishMatch));
    expect(withoutReason.includedInTotal).toBe(calculated.includedInTotal);
    expect(withoutReason.ranges).toEqual(calculated.ranges);
    expect(withoutReason.unavailableReason).toBe(calculated.unavailableReason);
    expect(NUTRITION_COVERAGE_REASONS).toHaveLength(5);
  });

  it("accepts nutrition matches saved before coverageReason existed", () => {
    const provider = new LocalNutritionProvider();
    const current = provider.resolve(benchmarkFoodEstimate("火鍋", "火鍋", "dish"));
    expect(current.coverageReason).toBe("COMPOSITE_UNSUPPORTED");
    expect(nutritionMatchResponseSchema.safeParse(current).success).toBe(true);

    const parsed = nutritionMatchResponseSchema.safeParse(withoutCoverageReason(current));
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).not.toHaveProperty("coverageReason");

    const rejected = nutritionMatchResponseSchema.safeParse({
      ...current,
      coverageReason: "NOT_A_REASON",
    });
    expect(rejected.success).toBe(false);

    const included = provider.resolve(benchmarkFoodEstimate("白飯", "白飯", "ingredient"));
    expect(included.includedInTotal).toBe(true);
    expect(included).not.toHaveProperty("coverageReason");
    expect(nutritionMatchResponseSchema.safeParse(included).success).toBe(true);
  });
});
