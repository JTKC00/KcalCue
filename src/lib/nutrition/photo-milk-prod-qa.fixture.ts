import type { FoodAnalysis, ObservedFood } from "@/lib/domain/food-analysis";

/**
 * Shapes from production QA of main abcae3b (kcalcue-00039-fes).
 * The masked network JSON and photos were not mounted in this workspace, so
 * these objects follow the captured failure contract: dish identity, a
 * guessed normalizedName, glass/drink wording, and an oat carton split into
 * name variants with different portions. They are not idealized 牛奶/milk rows.
 */

function drink(
  displayName: string,
  normalizedName: string,
  extra: Partial<ObservedFood> = {},
): ObservedFood {
  return {
    displayName,
    normalizedName,
    identityLevel: "dish",
    portionMin: 250,
    portionMax: 300,
    unit: "ml",
    recognitionConfidence: 0.71,
    portionConfidence: 0.48,
    uncertaintyReasons: ["外觀是白色飲品，未能從杯子判斷脂肪含量。"],
    preparationMethod: "冷飲",
    visibleIngredients: ["牛奶"],
    notes: "透明玻璃杯",
    ...extra,
  };
}

/** Plain glass. The model sometimes files it as a dish and guesses whole milk. */
export const glassOfMilkDishAnalysis = {
  analysisStatus: "success",
  foods: [
    drink("冷牛奶", "whole milk"),
    drink("牛奶飲品", "milk beverage", {
      portionMin: null,
      portionMax: null,
      uncertaintyReasons: ["另一個說法，同一隻杯。"],
    }),
  ],
  uncertaintyReasons: ["只有一隻玻璃杯。"],
  visibleEvidence: ["一隻透明玻璃杯", "白色液體"],
  estimatedInformation: ["份量大約 250–300 ml。"],
  unknownInformation: ["沒有包裝，看不到全脂或低脂字樣。"],
} satisfies FoodAnalysis;

/** What the server received after the user tapped 全脂牛奶 on a dish-classified row. */
export const wholeMilkChoiceStillDish = drink("全脂牛奶", "全脂牛奶", {
  portionMin: 250,
  portionMax: 250,
  uncertaintyReasons: ["模型將飲品標成菜式。"],
  visibleIngredients: ["牛奶"],
  notes: "玻璃杯",
});

/** Oat carton photo. Choosing 全脂 still arrived as a dish, with package evidence left on the meal. */
export const oatPackagingWholeMilkChoiceAnalysis = {
  analysisStatus: "success",
  foods: [wholeMilkChoiceStillDish],
  uncertaintyReasons: ["紙盒上的字只讀到一部分。"],
  visibleEvidence: ["紙盒包裝", "燕麥"],
  estimatedInformation: [],
  unknownInformation: ["品牌未能讀全。"],
} satisfies FoodAnalysis;

/** One oat carton split into name variants and different portions. */
export const oatCartonNameVariantsAnalysis = {
  analysisStatus: "success",
  foods: [
    drink("燕麥飲品", "oat beverage", {
      portionMin: 1000,
      portionMax: 1000,
      notes: "紙盒標示 1 公升",
      preparationMethod: "盒裝",
      visibleIngredients: ["燕麥"],
      uncertaintyReasons: ["紙盒容量不一定是飲用份量。"],
    }),
    drink("燕麥奶", "oat milk", {
      portionMin: 250,
      portionMax: 250,
      notes: "紙盒正面",
      preparationMethod: "紙盒飲品",
      visibleIngredients: ["燕麥奶"],
      uncertaintyReasons: ["同一紙盒的飲用份量。"],
    }),
  ],
  uncertaintyReasons: ["一盒飲品被拆成兩項。"],
  visibleEvidence: ["一盒燕麥飲品", "紙盒"],
  estimatedInformation: ["紙盒寫 1000 ml，杯量約 250 ml。"],
  unknownInformation: [],
} satisfies FoodAnalysis;

/**
 * Production FAIL 2 on abcae3b (kcalcue-00039-fes), verbatim.
 * Meal unknownInformation says the drink might be milk or plant milk.
 * The item uncertainty does not mention whole versus low-fat.
 */
export const productionGlassMilkUnknownAnalysis = {
  analysisStatus: "success",
  foods: [
    {
      displayName: "牛奶",
      normalizedName: "milk",
      identityLevel: "dish",
      unit: "ml",
      recognitionConfidence: 0.72,
      portionConfidence: 0.65,
      uncertaintyReasons: [
        "相片只顯示一杯白色飲品，沒有包裝或標籤，因此未能確認是牛奶還是其他類似飲品。",
        "玻璃杯沒有標準容量，份量是按液面高度及一般水杯大小作估算。",
      ],
      notes: "透明玻璃杯內有白色、不透明飲品；相片未見品牌或包裝文字。",
      portionMin: 250,
      portionMax: 350,
    },
  ],
  uncertaintyReasons: ["飲品外觀可辨認為牛奶類白色飲品，但沒有標籤，成分及種類未能完全確認。"],
  visibleEvidence: ["透明玻璃杯", "白色、不透明飲品", "未見品牌或包裝標籤"],
  estimatedInformation: ["按一般水杯大小及可見液面，估計約250至350毫升。"],
  unknownInformation: [
    "未能確認是否為牛奶、植物奶或其他白色飲品。",
    "未能確認脂肪含量、糖分及實際容量。",
  ],
} satisfies FoodAnalysis;

/** Generic row plus a more specific carton row. */
export const genericPlusOatCartonAnalysis = {
  analysisStatus: "success",
  foods: [
    drink("牛奶", "milk", {
      identityLevel: "ingredient",
      portionMin: null,
      portionMax: null,
      notes: "紙盒側面",
      visibleIngredients: undefined,
      uncertaintyReasons: ["未能讀到口味。"],
    }),
    drink("紙盒燕麥奶", "oat milk carton", {
      portionMin: 250,
      portionMax: 250,
      notes: "營養標示",
      preparationMethod: "紙盒",
      uncertaintyReasons: ["飲用份量不是整盒。"],
    }),
  ],
  uncertaintyReasons: ["只有一個紙盒。"],
  visibleEvidence: ["一盒植物奶"],
  estimatedInformation: [],
  unknownInformation: ["品牌。"],
} satisfies FoodAnalysis;
