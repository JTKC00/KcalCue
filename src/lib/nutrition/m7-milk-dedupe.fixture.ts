import type { FoodAnalysis, ObservedFood } from "@/lib/domain/food-analysis";

/**
 * Masked QA shapes for issue #127. The uploaded analyze JSON was not mounted
 * in this workspace, so these objects follow the stated contract exactly:
 * C3-run1 is two identical 燕麥奶 rows whose note is 「相片只顯示一盒燕麥奶」;
 * C3-run2 is one of those rows; C4 is two 牛奶 rows describing 前方玻璃杯 and
 * 後方另一個白色容器. They are not a second guess at unrelated fields.
 */
function oatMilk(note: string, extra: Partial<ObservedFood> = {}): ObservedFood {
  return {
    displayName: "燕麥奶",
    normalizedName: "oat milk",
    identityLevel: "ingredient",
    portionMin: 250,
    portionMax: 250,
    unit: "ml",
    recognitionConfidence: 0.74,
    portionConfidence: 0.58,
    uncertaintyReasons: [],
    preparationMethod: "冷藏飲品",
    notes: note,
    ...extra,
  };
}

function dairyMilk(
  note: string,
  extra: Partial<ObservedFood> = {},
): ObservedFood {
  return {
    displayName: "牛奶",
    normalizedName: "milk",
    identityLevel: "ingredient",
    portionMin: 200,
    portionMax: 250,
    unit: "ml",
    recognitionConfidence: 0.7,
    portionConfidence: 0.5,
    uncertaintyReasons: [],
    notes: note,
    ...extra,
  };
}

/** C3-run1. One carton came back as two identical rows and no duplicate notice. */
export const c3Run1SingleOatCartonAnalysis = {
  analysisStatus: "success",
  foods: [
    oatMilk("相片只顯示一盒燕麥奶"),
    oatMilk("相片只顯示一盒燕麥奶"),
  ],
  uncertaintyReasons: [],
  visibleEvidence: ["相片只顯示一盒燕麥奶"],
  estimatedInformation: [],
  unknownInformation: [],
} satisfies FoodAnalysis;

/** C3-run2. The same photo came back as one row. */
export const c3Run2SingleOatCartonAnalysis = {
  analysisStatus: "success",
  foods: [oatMilk("相片只顯示一盒燕麥奶")],
  uncertaintyReasons: [],
  visibleEvidence: ["相片只顯示一盒燕麥奶"],
  estimatedInformation: [],
  unknownInformation: [],
} satisfies FoodAnalysis;

/** C4 / oatmilk.jpg. Two milk rows and two described containers. */
export const c4TwoMilkContainersAnalysis = {
  analysisStatus: "success",
  foods: [
    dairyMilk("前方玻璃杯", { preparationMethod: "杯裝" }),
    dairyMilk("後方另一個白色容器", { preparationMethod: "冷藏飲品" }),
  ],
  uncertaintyReasons: [],
  visibleEvidence: ["前方玻璃杯", "後方另一個白色容器"],
  estimatedInformation: [],
  unknownInformation: [],
} satisfies FoodAnalysis;

/** M6. One carton and a separate glass stay two rows. */
export const m6CartonAndGlassAnalysis = {
  analysisStatus: "success",
  foods: [
    oatMilk("一盒燕麥奶", { preparationMethod: "紙盒" }),
    dairyMilk("獨立玻璃杯", { preparationMethod: "杯裝" }),
  ],
  uncertaintyReasons: [],
  visibleEvidence: ["一盒燕麥奶", "玻璃杯"],
  estimatedInformation: [],
  unknownInformation: [],
} satisfies FoodAnalysis;
