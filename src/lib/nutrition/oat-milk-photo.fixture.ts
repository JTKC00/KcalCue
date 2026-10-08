import type { FoodAnalysis } from "@/lib/domain/food-analysis";

/**
 * Production QA on cb1cd7e (kcalcue-00035-cik). An oat-milk carton photo
 * came back as 牛奶 at 250–350 ml. Whole milk at that volume is about
 * 155–220 kcal. The carton wording is on the meal, not in an item note.
 */
export const oatMilkCartonPhotoAnalysis = {
  analysisStatus: "success",
  foods: [
    {
      displayName: "牛奶",
      normalizedName: "milk",
      identityLevel: "ingredient",
      portionMin: 250,
      portionMax: 350,
      unit: "ml",
      recognitionConfidence: 0.72,
      portionConfidence: 0.64,
      uncertaintyReasons: ["紙盒上的品種未能逐字讀清。"],
      preparationMethod: "冷藏飲品",
    },
  ],
  uncertaintyReasons: ["飲品紙盒的植物奶字樣只見到一部分。"],
  visibleEvidence: ["紙盒寫有燕麥奶。"],
  estimatedInformation: ["份量大約是 250–350 ml。"],
  unknownInformation: ["紙盒是否還有其他口味。"],
} satisfies FoodAnalysis;
