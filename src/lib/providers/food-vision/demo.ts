import { foodAnalysisSchema, type FoodAnalysis } from "@/lib/domain/food-analysis";
import type { FoodImageInput, FoodVisionProvider } from "./types";

export const demoFoodAnalysis: FoodAnalysis = foodAnalysisSchema.parse({
  analysisStatus: "success",
  foods: [
    {
      displayName: "白飯",
      normalizedName: "cooked white rice",
      identityLevel: "ingredient",
      portionMin: 150,
      portionMax: 200,
      unit: "g",
      recognitionConfidence: 0.94,
      portionConfidence: 0.67,
      uncertaintyReasons: ["相片無法確認白飯的實際重量。"],
      preparationMethod: "熟",
      visibleIngredients: ["白飯"],
    },
    {
      displayName: "雞扒",
      normalizedName: "grilled chicken thigh",
      identityLevel: "ingredient",
      portionMin: 140,
      portionMax: 180,
      unit: "g",
      recognitionConfidence: 0.87,
      portionConfidence: 0.61,
      uncertaintyReasons: ["雞扒厚度及烹調用油無法從相片確定。"],
      preparationMethod: "煎或烤",
      visibleIngredients: ["雞扒"],
    },
    {
      displayName: "青菜",
      normalizedName: "cooked leafy greens",
      identityLevel: "ingredient",
      portionMin: 80,
      portionMax: 120,
      unit: "g",
      recognitionConfidence: 0.9,
      portionConfidence: 0.7,
      uncertaintyReasons: ["青菜是否加油炒製並不清楚。"],
      preparationMethod: "熟",
      visibleIngredients: ["葉菜"],
    },
    {
      displayName: "醬汁",
      normalizedName: "savory sauce",
      identityLevel: "ingredient",
      portionMin: 20,
      portionMax: 35,
      unit: "ml",
      recognitionConfidence: 0.68,
      portionConfidence: 0.48,
      uncertaintyReasons: ["醬汁配方、糖份及油份無法可靠判斷。"],
      visibleIngredients: ["深色醬汁"],
    },
  ],
  uncertaintyReasons: [
    "示範資料不是對你所選相片的實際 AI 分析。",
    "相片無法提供食物的真實重量。",
  ],
  visibleEvidence: ["示範餐包含白飯、雞扒、青菜及醬汁。"],
  estimatedInformation: ["各食物份量以常見餐碟比例建立示範範圍。"],
  unknownInformation: ["實際用油、醬汁配方及被遮蓋部分均不知道。"],
});

export class DemoFoodVisionProvider implements FoodVisionProvider {
  readonly id = "demo";
  readonly mode = "demo" as const;

  async analyzeImage(image: FoodImageInput): Promise<FoodAnalysis> {
    void image;
    return foodAnalysisSchema.parse(structuredClone(demoFoodAnalysis));
  }
}
