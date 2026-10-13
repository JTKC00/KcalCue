import type { FoodAnalysis } from "./food-analysis";

/** Exact value required. Any other string, including "true", leaves the trigger off. */
export const QA_SUSPECTED_MILK_ENV = "KCALCUE_QA_SUSPECTED_MILK";
export const QA_SUSPECTED_MILK_FIELD = "qaSuspectedMilk";

/**
 * Two whole-milk rows that do not share a container. preparePhotoMilkAnalysis
 * keeps both, marks the second suspected, and counts only the first.
 * 全脂牛奶 is used because a model label of 燕麥奶 is not counted until the
 * user picks a milk type, so that pair would hide the exclusion.
 * The same shape is stable if the client prepares the response again.
 */
export const qaSuspectedMilkAnalysis = {
  analysisStatus: "success",
  foods: [
    {
      displayName: "全脂牛奶",
      normalizedName: "whole milk",
      identityLevel: "ingredient",
      portionMin: 250,
      portionMax: 250,
      unit: "ml",
      recognitionConfidence: 0.8,
      portionConfidence: 0.7,
      uncertaintyReasons: [],
      preparationMethod: "紙盒",
      notes: "紙盒",
    },
    {
      displayName: "全脂牛奶",
      normalizedName: "whole milk",
      identityLevel: "ingredient",
      portionMin: 250,
      portionMax: 250,
      unit: "ml",
      recognitionConfidence: 0.6,
      portionConfidence: 0.5,
      uncertaintyReasons: [],
      notes: "白色飲品",
    },
  ],
  uncertaintyReasons: [],
  visibleEvidence: [],
  estimatedInformation: [],
  unknownInformation: [],
} satisfies FoodAnalysis;

export function qaSuspectedMilkFixtureEnabled(): boolean {
  return process.env[QA_SUSPECTED_MILK_ENV] === "1";
}

export function qaSuspectedMilkRequested(value: FormDataEntryValue | null): boolean {
  return value === "1";
}
