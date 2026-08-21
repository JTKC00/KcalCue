import { describe, expect, it } from "vitest";

import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { mealShowsTotal } from "@/lib/nutrition/calculation";
import { NutritionService } from "@/lib/nutrition/service";
import { representativeEvaluationCases } from "./fixtures";

function rangesAreSafe(meal: ReturnType<NutritionService["calculateMeal"]>): boolean {
  const ranges = [
    meal.totals.calories,
    meal.totals.protein,
    meal.totals.carbs,
    meal.totals.fat,
    ...meal.foods.flatMap((food) =>
      food.ranges
        ? [food.ranges.calories, food.ranges.protein, food.ranges.carbs, food.ranges.fat]
        : [],
    ),
  ];

  return ranges.every(
    (range) =>
      Number.isFinite(range.min) &&
      Number.isFinite(range.max) &&
      range.min >= 0 &&
      range.min <= range.max,
  );
}

describe("KcalCue deterministic evaluation", () => {
  it("runs representative resolution, coverage and calculation invariants", () => {
    const provider = new LocalNutritionProvider();
    const service = new NutritionService(provider);
    const failures: string[] = [];
    let passedCases = 0;
    let canonicalPass = 0;
    let nutritionPass = 0;
    let coveragePass = 0;
    let calculationPass = 0;

    for (const evaluationCase of representativeEvaluationCases) {
      const matches = evaluationCase.foods.map((food) => provider.resolve(food));
      const items = createEditableFoodItems(evaluationCase.foods, matches);
      const meal = service.calculateMeal(items);
      const repeatedMeal = service.calculateMeal(items);
      const prefix = `${evaluationCase.id}: ${evaluationCase.description}`;

      const canonicalOk = matches.every(
        (match, index) =>
          match.identity.canonicalName === evaluationCase.expectedCanonicalNames[index],
      );
      if (canonicalOk) canonicalPass += 1;
      else {
        failures.push(
          `${prefix} canonical identity mismatch (expected ${evaluationCase.expectedCanonicalNames.join(",")}; actual ${matches.map((match) => match.identity.canonicalName).join(",")})`,
        );
      }

      const nutritionOk = matches.every((match, index) => {
        const expectedIncluded = evaluationCase.expectedIncluded[index];
        const expectedMatchType = evaluationCase.expectedMatchTypes?.[index];
        return (
          match.includedInTotal === expectedIncluded &&
          (expectedMatchType === undefined || match.matchType === expectedMatchType)
        );
      });
      if (nutritionOk) nutritionPass += 1;
      else {
        failures.push(
          `${prefix} nutrition resolution mismatch (expected ${evaluationCase.expectedIncluded.map((included, index) => `${included}/${evaluationCase.expectedMatchTypes?.[index] ?? "*"}`).join(",")}; actual ${matches.map((match) => `${match.includedInTotal}/${match.matchType}`).join(",")})`,
        );
      }

      const coverageOk =
        meal.coverage === evaluationCase.expectedCoverage &&
        meal.includedCount === evaluationCase.expectedIncluded.filter(Boolean).length &&
        meal.totalCount === evaluationCase.foods.length &&
        mealShowsTotal(meal.coverage) ===
          (evaluationCase.expectedCoverage === "complete" ||
            evaluationCase.expectedCoverage === "partial");
      if (coverageOk) coveragePass += 1;
      else failures.push(`${prefix} coverage mismatch (expected ${evaluationCase.expectedCoverage}; actual ${meal.coverage})`);

      const calculationOk =
        rangesAreSafe(meal) &&
        JSON.stringify(meal) === JSON.stringify(repeatedMeal) &&
        meal.foods.every((calculated, index) =>
          evaluationCase.expectedIncluded[index]
            ? calculated.ranges !== null && calculated.includedInTotal
            : calculated.ranges === null && !calculated.includedInTotal,
        );
      if (calculationOk) calculationPass += 1;
      else failures.push(`${prefix} calculation invariant mismatch`);

      if (canonicalOk && nutritionOk && coverageOk && calculationOk) {
        passedCases += 1;
      }
    }

    const report = [
      "KcalCue Evaluation",
      "",
      `Cases: ${representativeEvaluationCases.length}`,
      `PASS: ${passedCases}`,
      `FAIL: ${representativeEvaluationCases.length - passedCases}`,
      `Canonical resolution: ${canonicalPass}/${representativeEvaluationCases.length}`,
      `Nutrition resolution: ${nutritionPass}/${representativeEvaluationCases.length}`,
      `Coverage rules: ${coveragePass}/${representativeEvaluationCases.length}`,
      `Calculation invariants: ${calculationPass}/${representativeEvaluationCases.length}`,
      ...(failures.length > 0 ? ["", "Failures:", ...failures.map((failure) => `- ${failure}`)] : []),
    ].join("\n");
    process.stdout.write(`${report}\n`);

    expect(failures, report).toEqual([]);
  });
});
