import type { FoodAnalysis } from "@/lib/domain/food-analysis";

/**
 * Masked live analyze payloads from QA #126 (gpt-5.6-luna, food-vision-v2).
 * Field text is copied verbatim. Provenance on every call was
 * openai / gpt-5.6-luna / food-vision-v2 / mode live; that metadata is not
 * part of the FoodAnalysis schema.
 * otherMilkNotice below is the notice the app attached to those responses.
 * C4's copy is the false positive this regression removes.
 */
const PLANT_NOTICE = "包裝顯示植物奶，請核對種類及份量。";

/** C3-run1. One oat carton returned as two rows. */
export const c3Run1SingleOatCartonAnalysis = {
  analysisStatus: "success",
  foods: [
    {
      displayName: "燕麥奶",
      normalizedName: "oat milk",
      identityLevel: "ingredient",
      portionMin: null,
      portionMax: null,
      unit: "ml",
      recognitionConfidence: 0.99,
      portionConfidence: 0.05,
      uncertaintyReasons: ["相片只顯示一盒燕麥奶，未能確認你實際飲用了多少；包裝容量不等於飲用份量。"],
      notes: "包裝可讀到「OATLY」、「THE ORIGINAL」、「WATER HAVER BARISTA EDITION」、「100% cool for vegans」及「1L」；標示為燕麥奶飲品。",
      otherMilkNotice: PLANT_NOTICE,
    },
    {
      displayName: "燕麥奶",
      normalizedName: "oat milk",
      identityLevel: "ingredient",
      portionMin: null,
      portionMax: null,
      unit: "ml",
      recognitionConfidence: 0.98,
      portionConfidence: 0.05,
      uncertaintyReasons: ["相片只顯示一盒燕麥奶，未能確認你實際飲用了多少；包裝容量不等於飲用份量。"],
      notes: "包裝可讀到「OATLY」、「THE ORIGINAL」、「WATER HAVER BARISTA EDITION」、「100% cool for vegans」及「1L」；標示為燕麥奶飲品。",
      otherMilkNotice: PLANT_NOTICE,
    },
  ],
  uncertaintyReasons: ["相片只見到燕麥奶紙盒，沒有杯中份量或實際飲用量的證據。"],
  visibleEvidence: ["OATLY", "THE ORIGINAL", "WATER HAVER BARISTA EDITION", "100% cool for vegans", "1L"],
  estimatedInformation: ["紙盒標示容量為1 L，但不能當作你的飲用份量。"],
  unknownInformation: [],
} satisfies FoodAnalysis;

/** C3-run2. The same carton photo returned as one row. */
export const c3Run2SingleOatCartonAnalysis = {
  analysisStatus: "success",
  foods: [
    {
      displayName: "燕麥奶",
      normalizedName: "oat milk",
      identityLevel: "dish",
      portionMin: null,
      portionMax: null,
      unit: "ml",
      recognitionConfidence: 0.99,
      portionConfidence: 0.05,
      uncertaintyReasons: [
        "相片只見到一盒燕麥奶包裝，沒有顯示實際倒出或飲用的分量。",
        "包裝上的「1L」是容量，不代表使用者實際飲用的分量。",
      ],
      notes: "可讀到品牌及字樣：「OATLY」、「HAFER」、「BARISTA EDITION」、「100% cool for vegans」及「1L」；包裝顯示為燕麥奶。",
      otherMilkNotice: PLANT_NOTICE,
    },
  ],
  uncertaintyReasons: [],
  visibleEvidence: [],
  estimatedInformation: [],
  unknownInformation: [],
} satisfies FoodAnalysis;

/**
 * C4. A glass in front and another white container behind.
 * Both rows wrongly carried the plant-packaging notice.
 */
export const c4TwoMilkContainersAnalysis = {
  analysisStatus: "success",
  foods: [
    {
      displayName: "牛奶",
      normalizedName: "milk",
      identityLevel: "dish",
      portionMin: 250,
      portionMax: 400,
      unit: "ml",
      recognitionConfidence: 0.48,
      portionConfidence: 0.65,
      uncertaintyReasons: [
        "白色飲品沒有可見標籤，單憑外觀未能確定是牛奶，也可能是植物奶。",
        "玻璃杯容量及實際飲用量只能按畫面中的液面作粗略估算。",
      ],
      notes: "前方透明玻璃杯內可見白色飲品；沒有品牌或包裝文字可供確認。",
      otherMilkNotice: PLANT_NOTICE,
    },
    {
      displayName: "牛奶",
      normalizedName: "milk",
      identityLevel: "dish",
      portionMin: 200,
      portionMax: 350,
      unit: "ml",
      recognitionConfidence: 0.4,
      portionConfidence: 0.4,
      uncertaintyReasons: [
        "後方容器大部分被前方玻璃杯遮擋，飲品種類及份量較難確認。",
        "白色飲品沒有可見標籤，單憑外觀未能確定是牛奶，也可能是植物奶。",
      ],
      notes: "後方可見另一個白色容器，內有相似的白色飲品；容器邊界及液面部分被遮擋，沒有品牌或包裝文字。",
      otherMilkNotice: PLANT_NOTICE,
    },
  ],
  uncertaintyReasons: [],
  visibleEvidence: [
    "前方透明玻璃杯內有白色飲品。",
    "後方另有一個白色容器，內有相似白色飲品。",
  ],
  estimatedInformation: [],
  unknownInformation: [],
} satisfies FoodAnalysis;

/** M6. One carton and a separate glass stay two rows. */
export const m6CartonAndGlassAnalysis = {
  analysisStatus: "success",
  foods: [
    {
      displayName: "燕麥奶",
      normalizedName: "oat milk",
      identityLevel: "ingredient",
      portionMin: 250,
      portionMax: 250,
      unit: "ml",
      recognitionConfidence: 0.74,
      portionConfidence: 0.58,
      uncertaintyReasons: [],
      preparationMethod: "紙盒",
      notes: "一盒燕麥奶",
    },
    {
      displayName: "牛奶",
      normalizedName: "milk",
      identityLevel: "ingredient",
      portionMin: 200,
      portionMax: 250,
      unit: "ml",
      recognitionConfidence: 0.7,
      portionConfidence: 0.5,
      uncertaintyReasons: [],
      preparationMethod: "杯裝",
      notes: "獨立玻璃杯",
    },
  ],
  uncertaintyReasons: [],
  visibleEvidence: ["一盒燕麥奶", "玻璃杯"],
  estimatedInformation: [],
  unknownInformation: [],
} satisfies FoodAnalysis;
