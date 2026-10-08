import type { FoodAnalysis, ObservedFood } from "@/lib/domain/food-analysis";

/**
 * Production QA on f7db202 (kcalcue-00037-kid). One oat-milk carton came back
 * as two 牛奶 items. The model gave no plant-milk wording, so the plant-milk
 * guard did not fire. Portions were empty until the user entered 250 ml on
 * each row, and each row then mapped to USDA whole milk.
 */
function milkItem(uncertainty: string, recognitionConfidence: number): ObservedFood {
  return {
    displayName: "牛奶",
    normalizedName: "milk",
    identityLevel: "ingredient",
    portionMin: null,
    portionMax: null,
    unit: "ml",
    recognitionConfidence,
    portionConfidence: 0.2,
    uncertaintyReasons: [uncertainty],
    preparationMethod: "紙盒飲品",
  };
}

export const duplicateGenericMilkCartonAnalysis = {
  analysisStatus: "success",
  foods: [
    milkItem("未能讀到紙盒上的種類。", 0.7),
    milkItem("同一紙盒被分成兩項。", 0.66),
  ],
  uncertaintyReasons: ["紙盒飲品的種類未能確認。"],
  visibleEvidence: ["一盒飲品。"],
  estimatedInformation: [],
  unknownInformation: ["紙盒上的品牌與種類未能讀到。"],
} satisfies FoodAnalysis;
