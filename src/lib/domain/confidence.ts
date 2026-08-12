import type { FoodAnalysis, FoodEstimate } from "./food-analysis";

export type ConfidenceLevel = "high" | "medium" | "low";

export function confidenceLevel(score: number): ConfidenceLevel {
  if (score >= 0.8) return "high";
  if (score >= 0.55) return "medium";
  return "low";
}

export function foodConfidence(food: FoodEstimate): ConfidenceLevel {
  return confidenceLevel(
    Math.min(food.recognitionConfidence, food.portionConfidence),
  );
}

export function mealConfidence(foods: FoodEstimate[]): ConfidenceLevel {
  if (foods.length === 0) return "low";
  const conservativeScore = Math.min(
    ...foods.map((food) =>
      Math.min(food.recognitionConfidence, food.portionConfidence),
    ),
  );
  return confidenceLevel(conservativeScore);
}

export function collectUncertaintyReasons(analysis: FoodAnalysis): string[] {
  const reasons = [
    ...analysis.uncertaintyReasons,
    ...analysis.unknownInformation,
    ...analysis.foods.flatMap((food) => food.uncertaintyReasons),
  ];
  const seen = new Set<string>();

  const unique = reasons.filter((reason) => {
    const key = reason.trim().toLocaleLowerCase("zh-HK");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return unique.length > 0
    ? unique
    : ["相片無法提供食物的實際重量及完整烹調資料。"];
}
