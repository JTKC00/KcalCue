import { describe, expect, it } from "vitest";

import type { FoodEstimate } from "@/lib/domain/food-analysis";
import { dedupeIdenticalContainerMilk, MERGED_DUPLICATE_MILK_NOTICE } from "@/lib/domain/milk-dedupe";
import { calculateFoodNutrition, roundRange } from "./calculation";
import {
  contradictoryDairyMilkLabel,
  explicitLowFatMilk,
  genericMilkLabel,
  mealPlantMilkContext,
  photoGenericMilkNeedsConfirmation,
} from "./canonical";
import { duplicateGenericMilkCartonAnalysis } from "./duplicate-milk-carton.fixture";
import {
  genericPlusOatCartonAnalysis,
  glassOfMilkDishAnalysis,
  oatCartonNameVariantsAnalysis,
  oatPackagingWholeMilkChoiceAnalysis,
  productionGlassMilkUnknownAnalysis,
  wholeMilkChoiceStillDish,
} from "./photo-milk-prod-qa.fixture";
import { localNutritionProfiles } from "./local-data";
import { LocalNutritionProvider } from "./local-provider";
import {
  CHOCOLATE_MILK_UNCALCULATED_REASON,
  LOW_FAT_MILK_UNCALCULATED_REASON,
  PHOTO_GENERIC_MILK_CONFIRMATION_REASON,
  PHOTO_MILK_OTHER_REASON,
  PLANT_MILK_CONTRADICTION_REASON,
} from "./negative-rules";
import { isMilkTypeUncertainty } from "./photo-milk";
import { findLowFatMilkProfile, resolveNutritionMatch, type ResolvableFood } from "./resolver";
import type { NutritionProfile } from "./types";
import { NutritionService } from "./service";
import { createEditableFoodItems, renameFoodItem } from "@/lib/domain/editable-meal";
import { mealInputSchema } from "@/lib/meals/types";

function food(
  displayName: string,
  normalizedName: string,
  extra: Partial<ResolvableFood> = {},
): ResolvableFood {
  return {
    displayName,
    normalizedName,
    identityLevel: "ingredient",
    portionMin: 250,
    portionMax: 250,
    unit: "ml",
    recognitionConfidence: 0.8,
    portionConfidence: 0.6,
    uncertaintyReasons: [],
    ...extra,
  };
}

const provider = new LocalNutritionProvider();

describe("photo generic milk", () => {
  it.each(["oat", "soy"] as const)("counts a 250 ml %s choice and preserves the choice after an edit and save parsing", (choice) => {
    const chosen = food("牛奶", "milk", { userMilkTypeChoice: choice, entrySource: "photo", identityLevel: "dish", notes: "植物奶紙盒" });
    const match = provider.resolve(chosen);
    expect(match.profile?.id).toBe(choice === "oat" ? "oat-milk" : "unsweetened-soy-milk");
    expect(match.profile?.id).not.toBe("whole-milk");
    expect(match.includedInTotal).toBe(true);
    const calculated = new NutritionService(provider).calculateMeal([chosen]);
    expect(calculated.includedCount).toBe(1);
    expect(calculated.totals.calories.min).toBeGreaterThan(0);
    expect(calculated.totals.calories).toEqual(calculated.foods[0].ranges?.calories);
    expect(roundRange(calculated.totals.calories, 5)).toEqual(choice === "oat" ? { min: 115, max: 120 } : { min: 80, max: 85 });
    const item = { ...createEditableFoodItems([chosen])[0], userMilkTypeChoice: choice, entrySource: "photo" as const };
    const edited = renameFoodItem({ ...item, portionMin: 250, portionMax: 250 }, choice === "oat" ? "燕麥奶" : "豆漿");
    const saved = mealInputSchema.parse({ id: "11111111-1111-4111-8111-111111111111", mutationId: "22222222-2222-4222-8222-222222222222", version: 0, date: "2026-10-09", time: "08:00", timezone: "Asia/Hong_Kong", photoPath: null, mealType: "breakfast", mode: "live", analysis: null, items: [edited] });
    expect(saved.items[0].userMilkTypeChoice).toBe(choice);
    expect(provider.resolve(saved.items[0] as typeof chosen).includedInTotal).toBe(true);
  });

  it("keeps two carton rows when no evidence explicitly says they are the same serving", () => {
    const row = food("牛奶", "milk", { preparationMethod: "紙盒" });
    const analysis = { ...duplicateGenericMilkCartonAnalysis, foods: [row, { ...row }], uncertaintyReasons: [], visibleEvidence: ["紙盒"], unknownInformation: [] };
    expect(dedupeIdenticalContainerMilk(analysis).foods).toHaveLength(2);
  });

  it("keeps typed 牛奶 and 鮮奶 on whole milk", () => {
    for (const item of [
      food("牛奶", "milk"),
      food("牛奶", "whole milk"),
      food("鮮奶", "fresh milk"),
      food("熱牛奶", "hot milk"),
    ]) {
      const match = provider.resolve(item);
      expect(match.profile?.id, item.displayName).toBe("whole-milk");
      expect(match.includedInTotal, item.displayName).toBe(true);
      expect(photoGenericMilkNeedsConfirmation(item), item.displayName).toBe(false);
    }
  });

  it("does not map a photo labelled only 牛奶 to whole milk", () => {
    const drink = food("牛奶", "milk", { entrySource: "photo" });
    const match = provider.resolve(drink);
    const calories = calculateFoodNutrition(drink, match).ranges?.calories;

    expect(genericMilkLabel("牛奶")).toBe(true);
    expect(genericMilkLabel("熱牛奶")).toBe(true);
    expect(genericMilkLabel("冷牛奶")).toBe(true);
    expect(genericMilkLabel("牛奶飲品")).toBe(true);
    expect(genericMilkLabel("玻璃杯牛奶")).toBe(true);
    expect(genericMilkLabel("鮮牛奶")).toBe(true);
    expect(genericMilkLabel("glass of milk")).toBe(true);
    expect(genericMilkLabel("鮮奶")).toBe(false);
    expect(genericMilkLabel("全脂牛奶")).toBe(false);
    expect(genericMilkLabel("朱古力奶")).toBe(false);
    expect(genericMilkLabel("奶茶")).toBe(false);
    expect(genericMilkLabel("牛奶麥片")).toBe(false);
    for (const item of [
      food("朱古力奶", "chocolate milk", { entrySource: "photo" }),
      food("朱古力奶", "chocolate milk"),
      food("巧克力牛奶", "chocolate milk", { entrySource: "photo" }),
    ]) {
      const chocolate = provider.resolve(item);
      expect(photoGenericMilkNeedsConfirmation(item), item.displayName).toBe(false);
      expect(chocolate.profile?.id, item.displayName).not.toBe("whole-milk");
      expect(chocolate.includedInTotal, item.displayName).toBe(false);
      expect(chocolate.reasons[0], item.displayName).toBe(CHOCOLATE_MILK_UNCALCULATED_REASON);
    }
    expect(photoGenericMilkNeedsConfirmation(drink)).toBe(true);
    expect(match.profile).toBeNull();
    expect(match.includedInTotal).toBe(false);
    expect(match.coverageReason).toBe("AMBIGUOUS_MATCH");
    expect(match.reasons[0]).toBe(PHOTO_GENERIC_MILK_CONFIRMATION_REASON);
    expect(calories).toBeUndefined();
  });

  it("still maps photo 鮮奶 and 全脂奶, and computes only after 全脂牛奶 is chosen", () => {
    const fresh = food("鮮奶", "fresh milk", { entrySource: "photo" });
    expect(provider.resolve(fresh).profile?.id).toBe("whole-milk");

    const namedWhole = food("全脂牛奶", "whole milk", { entrySource: "photo" });
    const match = provider.resolve(namedWhole);
    const calories = calculateFoodNutrition(namedWhole, match).ranges?.calories;
    expect(match.profile?.id).toBe("whole-milk");
    expect(match.includedInTotal).toBe(true);
    expect(calories && roundRange(calories, 5)).toEqual({ min: 155, max: 160 });
  });

  it("leaves low-fat milk uncomputed until a catalog entry exists", () => {
    expect(findLowFatMilkProfile(localNutritionProfiles)).toBeNull();
    const chosen = food("低脂牛奶", "low-fat milk", { entrySource: "photo" });
    const match = provider.resolve(chosen);
    expect(explicitLowFatMilk(chosen)).toBe(true);
    expect(match.profile?.id).not.toBe("whole-milk");
    expect(match.includedInTotal).toBe(false);
    expect(match.reasons[0]).toBe(LOW_FAT_MILK_UNCALCULATED_REASON);

    const reduced: NutritionProfile = {
      ...localNutritionProfiles.find((profile) => profile.id === "whole-milk")!,
      id: "reduced-fat-milk",
      displayName: "低脂奶",
      canonicalName: "reduced-fat-milk",
      aliases: ["low-fat milk", "reduced-fat milk", "低脂奶", "低脂牛奶"],
    };
    const mapped = resolveNutritionMatch(chosen, [...localNutritionProfiles, reduced]);
    expect(mapped.profile?.id).toBe("reduced-fat-milk");
    expect(mapped.includedInTotal).toBe(true);
  });

  it("keeps a plant-milk bottle label uncomputed", () => {
    const bottle = food("奶類／植物奶飲品", "plant milk drink", { entrySource: "photo" });
    const match = provider.resolve(bottle);
    expect(photoGenericMilkNeedsConfirmation(bottle)).toBe(false);
    expect(match.profile?.id).not.toBe("whole-milk");
    expect(match.includedInTotal).toBe(false);
  });

  it("computes 全脂牛奶 after the choice drops uncertainty that could not tell low-fat apart", () => {
    const ambiguous = food("全脂牛奶", "whole milk", {
      entrySource: "photo",
      uncertaintyReasons: ["未能分辨全脂或低脂"],
    });
    expect(provider.resolve(ambiguous).profile?.id).not.toBe("whole-milk");
    expect(isMilkTypeUncertainty("未能分辨全脂或低脂")).toBe(true);
    expect(isMilkTypeUncertainty("未能讀到紙盒上的種類。")).toBe(false);
    expect(isMilkTypeUncertainty(MERGED_DUPLICATE_MILK_NOTICE)).toBe(false);

    const chosen = {
      ...ambiguous,
      uncertaintyReasons: ambiguous.uncertaintyReasons.filter((reason) => !isMilkTypeUncertainty(reason)),
    };
    const match = provider.resolve(chosen);
    const calories = calculateFoodNutrition(chosen, match).ranges?.calories;
    expect(explicitLowFatMilk(chosen)).toBe(false);
    expect(match.profile?.id).toBe("whole-milk");
    expect(match.includedInTotal).toBe(true);
    expect(calories && roundRange(calories, 5)).toEqual({ min: 155, max: 160 });

    const plantUncertainty = food("全脂奶", "whole milk", {
      uncertaintyReasons: ["杏仁奶"],
    });
    expect(provider.resolve(plantUncertainty).profile?.id).not.toBe("whole-milk");
  });

  it("merges two identical milk rows from one carton and does not double the calories", () => {
    const merged = dedupeIdenticalContainerMilk(duplicateGenericMilkCartonAnalysis);
    expect(duplicateGenericMilkCartonAnalysis.foods).toHaveLength(2);
    expect(merged.foods).toHaveLength(1);
    expect(merged.foods[0]).toMatchObject({ displayName: "牛奶", portionMin: null, portionMax: null });
    expect(merged.foods[0].duplicateMilkNotice).toBe(MERGED_DUPLICATE_MILK_NOTICE);
    expect(merged.foods[0].uncertaintyReasons).not.toContain(MERGED_DUPLICATE_MILK_NOTICE);

    const one = food("牛奶", "milk", { entrySource: "photo" });
    const confirmed = food("全脂牛奶", "whole milk", { entrySource: "photo" });
    const single = calculateFoodNutrition(confirmed, provider.resolve(confirmed)).ranges?.calories;
    expect(provider.resolve(one).includedInTotal).toBe(false);
    expect(single && roundRange(single, 5)).toEqual({ min: 155, max: 160 });

    const distinct = dedupeIdenticalContainerMilk({
      ...duplicateGenericMilkCartonAnalysis,
      foods: [
        duplicateGenericMilkCartonAnalysis.foods[0],
        { ...duplicateGenericMilkCartonAnalysis.foods[1], notes: "旁邊另一杯" },
      ],
    });
    expect(distinct.foods).toHaveLength(2);

    const apples = dedupeIdenticalContainerMilk({
      ...duplicateGenericMilkCartonAnalysis,
      foods: [
        { ...duplicateGenericMilkCartonAnalysis.foods[0], displayName: "蘋果", normalizedName: "apple", unit: "piece" },
        { ...duplicateGenericMilkCartonAnalysis.foods[1], displayName: "蘋果", normalizedName: "apple", unit: "piece" },
      ],
    });
    expect(apples.foods).toHaveLength(2);
  });

  it("shows the chooser for every generic-milk phrasing from the glass photo, including a dish label", () => {
    const context = {
      visibleEvidence: glassOfMilkDishAnalysis.visibleEvidence,
      uncertaintyText: glassOfMilkDishAnalysis.uncertaintyReasons,
    };
    for (const item of glassOfMilkDishAnalysis.foods) {
      const photo = food(item.displayName, item.normalizedName, {
        entrySource: "photo",
        identityLevel: item.identityLevel,
        notes: item.notes,
        preparationMethod: item.preparationMethod,
        visibleIngredients: item.visibleIngredients,
        uncertaintyReasons: item.uncertaintyReasons,
      });
      expect(photoGenericMilkNeedsConfirmation(photo, context), item.displayName).toBe(true);
      const match = provider.resolve(photo, context);
      expect(match.includedInTotal, item.displayName).toBe(false);
      expect(match.profile, item.displayName).toBeNull();
      expect(match.coverageReason, item.displayName).not.toBe("UNKNOWN_DISH");
    }
    for (const [displayName, normalizedName] of [
      ["飲品", "milk"],
      ["白牛奶", "dairy milk"],
      ["純牛奶", "plain milk"],
    ] as const) {
      const photo = food(displayName, normalizedName, { entrySource: "photo", identityLevel: "dish" });
      expect(photoGenericMilkNeedsConfirmation(photo, {
        visibleEvidence: ["可能是植物奶"],
      }), displayName).toBe(true);
    }
  });

  it("counts 全脂牛奶 at 250 ml after a dish-classified row, even when the meal still says 燕麥", () => {
    const chosen = food(wholeMilkChoiceStillDish.displayName, wholeMilkChoiceStillDish.normalizedName, {
      entrySource: "photo",
      identityLevel: "dish",
      notes: wholeMilkChoiceStillDish.notes,
      preparationMethod: wholeMilkChoiceStillDish.preparationMethod,
      visibleIngredients: wholeMilkChoiceStillDish.visibleIngredients,
      uncertaintyReasons: wholeMilkChoiceStillDish.uncertaintyReasons,
      userMilkTypeChoice: "whole",
    });
    const context = {
      visibleEvidence: oatPackagingWholeMilkChoiceAnalysis.visibleEvidence,
      uncertaintyText: oatPackagingWholeMilkChoiceAnalysis.uncertaintyReasons,
    };
    const match = provider.resolve(chosen, context);
    const calories = calculateFoodNutrition(chosen, match).ranges?.calories;
    expect(match.profile?.id).toBe("whole-milk");
    expect(match.includedInTotal).toBe(true);
    expect(match.coverageReason).not.toBe("UNKNOWN_DISH");
    expect(calories && roundRange(calories, 5)).toEqual({ min: 155, max: 160 });

    const lowFat = food("低脂牛奶", "low-fat milk", {
      entrySource: "photo",
      identityLevel: "dish",
    });
    expect(provider.resolve(lowFat).includedInTotal).toBe(false);
    expect(provider.resolve(lowFat).reasons[0]).toBe(LOW_FAT_MILK_UNCALCULATED_REASON);
  });

  it("merges an oat carton split into name variants without using an uncertainty slot", () => {
    const merged = dedupeIdenticalContainerMilk(oatCartonNameVariantsAnalysis);
    expect(oatCartonNameVariantsAnalysis.foods).toHaveLength(2);
    expect(merged.foods).toHaveLength(1);
    expect(merged.foods[0].displayName).toBe("燕麥奶");
    expect(merged.foods[0].portionMin).toBe(250);
    expect(merged.foods[0].portionMax).toBe(250);
    expect(merged.foods[0].duplicateMilkNotice).toBe(MERGED_DUPLICATE_MILK_NOTICE);
    expect(merged.foods[0].uncertaintyReasons).not.toContain(MERGED_DUPLICATE_MILK_NOTICE);

    const full = dedupeIdenticalContainerMilk({
      ...oatCartonNameVariantsAnalysis,
      foods: [
        {
          ...oatCartonNameVariantsAnalysis.foods[1],
          uncertaintyReasons: ["1", "2", "3", "4", "5", "6", "7", "8"],
        },
        oatCartonNameVariantsAnalysis.foods[0],
      ],
    });
    expect(full.foods[0].uncertaintyReasons).toHaveLength(8);
    expect(full.foods[0].duplicateMilkNotice).toBe(MERGED_DUPLICATE_MILK_NOTICE);

    const genericAndOat = dedupeIdenticalContainerMilk(genericPlusOatCartonAnalysis);
    expect(genericAndOat.foods).toHaveLength(1);
    expect(genericAndOat.foods[0].displayName).toBe("紙盒燕麥奶");
    expect(genericAndOat.foods[0].duplicateMilkNotice).toBe(MERGED_DUPLICATE_MILK_NOTICE);
  });

  it("shows the chooser for the production glass, then counts 全脂 at 250 ml", () => {
    const source = productionGlassMilkUnknownAnalysis.foods[0];
    const context = mealPlantMilkContext({ analysis: productionGlassMilkUnknownAnalysis });
    const photo = food(source.displayName, source.normalizedName, {
      entrySource: "photo",
      identityLevel: source.identityLevel,
      portionMin: source.portionMin,
      portionMax: source.portionMax,
      unit: source.unit,
      recognitionConfidence: source.recognitionConfidence,
      portionConfidence: source.portionConfidence,
      uncertaintyReasons: source.uncertaintyReasons,
      notes: source.notes,
    });

    expect(context.uncertaintyText).toContain("未能確認是否為牛奶、植物奶或其他白色飲品。");
    expect(photoGenericMilkNeedsConfirmation(photo, context)).toBe(true);
    expect(contradictoryDairyMilkLabel(photo, context)).toBe(false);
    expect(isMilkTypeUncertainty(source.uncertaintyReasons[0])).toBe(false);

    const blocked = provider.resolve(photo, context);
    expect(blocked.includedInTotal).toBe(false);
    expect(blocked.profile).toBeNull();
    expect(blocked.reasons[0]).toBe(PHOTO_GENERIC_MILK_CONFIRMATION_REASON);
    expect(blocked.reasons).not.toContain(PLANT_MILK_CONTRADICTION_REASON);
    expect(blocked.coverageReason).not.toBe("UNKNOWN_DISH");

    const chosen = food("全脂牛奶", "全脂牛奶", {
      entrySource: "photo",
      identityLevel: "dish",
      portionMin: 250,
      portionMax: 250,
      unit: "ml",
      uncertaintyReasons: source.uncertaintyReasons,
      notes: source.notes,
      userMilkTypeChoice: "whole",
    });
    const match = provider.resolve(chosen, context);
    const calories = calculateFoodNutrition(chosen, match).ranges?.calories;
    expect(match.profile?.id).toBe("whole-milk");
    expect(match.includedInTotal).toBe(true);
    expect(match.coverageReason).not.toBe("UNKNOWN_DISH");
    expect(match.identity.canonicalName).not.toBe("mixed-dish");
    expect(calories && roundRange(calories, 5)).toEqual({ min: 155, max: 160 });
  });

  it("does not treat a model label of 全脂牛奶 on an oat carton as the user's choice", () => {
    const modeled = food("全脂牛奶", "全脂牛奶", {
      entrySource: "photo",
      identityLevel: "dish",
      notes: "紙盒標示燕麥奶",
      uncertaintyReasons: ["包裝是燕麥奶。"],
    });
    const context = {
      visibleEvidence: ["燕麥奶紙盒"],
      uncertaintyText: ["紙盒寫有燕麥奶。"],
    };
    expect(modeled.userMilkTypeChoice).toBeUndefined();
    expect(contradictoryDairyMilkLabel(modeled, context)).toBe(true);
    const match = provider.resolve(modeled, context);
    expect(match.profile).toBeNull();
    expect(match.includedInTotal).toBe(false);
    expect(match.reasons[0]).toBe(PLANT_MILK_CONTRADICTION_REASON);
    expect(match.coverageReason).toBe("INSUFFICIENT_COVERAGE");

    const chosen = { ...modeled, userMilkTypeChoice: "whole" as const };
    const counted = provider.resolve(chosen, context);
    const calories = calculateFoodNutrition(chosen, counted).ranges?.calories;
    expect(counted.profile?.id).toBe("whole-milk");
    expect(counted.includedInTotal).toBe(true);
    expect(calories && roundRange(calories, 5)).toEqual({ min: 155, max: 160 });
  });

  it("keeps manual 牛奶飲品 on whole milk and still asks on a photo", () => {
    const typed = food("牛奶飲品", "牛奶飲品", { entrySource: "manual" });
    expect(photoGenericMilkNeedsConfirmation(typed)).toBe(false);
    expect(provider.resolve(typed).profile?.id).toBe("whole-milk");
    expect(provider.resolve(typed).includedInTotal).toBe(true);

    const photo = food("牛奶飲品", "milk beverage", { entrySource: "photo", identityLevel: "dish" });
    expect(photoGenericMilkNeedsConfirmation(photo)).toBe(true);
    expect(provider.resolve(photo).includedInTotal).toBe(false);
    expect(provider.resolve(photo).reasons[0]).toBe(PHOTO_GENERIC_MILK_CONFIRMATION_REASON);
  });

  it("stores 其他 on its own field and does not spend an uncertainty slot", () => {
    const other = food("牛奶", "milk", {
      entrySource: "photo",
      userMilkTypeChoice: "other",
      otherMilkNotice: PHOTO_MILK_OTHER_REASON,
      uncertaintyReasons: ["玻璃杯沒有刻度。"],
    });
    const match = provider.resolve(other);
    expect(match.includedInTotal).toBe(false);
    expect(match.reasons[0]).toBe(PHOTO_MILK_OTHER_REASON);
    expect(other.uncertaintyReasons).not.toContain(PHOTO_MILK_OTHER_REASON);
  });

  it("does not merge a fresh-milk carton with a glass, or milk with a packaged sandwich", () => {
    const row = (
      displayName: string,
      normalizedName: string,
      extra: Partial<ResolvableFood> = {},
    ) => food(displayName, normalizedName, { identityLevel: "ingredient", ...extra });
    const cartonAndGlass = dedupeIdenticalContainerMilk({
      analysisStatus: "success",
      foods: [
        row("鮮奶", "fresh milk", { preparationMethod: "紙盒", notes: "一盒鮮奶" }),
        row("牛奶", "milk", { notes: "玻璃杯", preparationMethod: "杯裝" }),
      ],
      uncertaintyReasons: [],
      visibleEvidence: ["一盒鮮奶", "一杯牛奶"],
      estimatedInformation: [],
      unknownInformation: [],
    });
    expect(cartonAndGlass.foods.map((item) => item.displayName)).toEqual(["鮮奶", "牛奶"]);
    expect(cartonAndGlass.foods.every((item) => item.duplicateMilkNotice == null)).toBe(true);

    const sandwichAndGlass = dedupeIdenticalContainerMilk({
      analysisStatus: "success",
      foods: [
        row("三文治", "sandwich", { unit: "piece", notes: "包裝三文治", portionMin: 1, portionMax: 1 }),
        row("牛奶", "milk", { notes: "玻璃杯" }),
      ],
      uncertaintyReasons: [],
      visibleEvidence: ["包裝", "一杯牛奶"],
      estimatedInformation: [],
      unknownInformation: [],
    });
    expect(sandwichAndGlass.foods).toHaveLength(2);
    expect(sandwichAndGlass.foods[1].displayName).toBe("牛奶");
    expect(sandwichAndGlass.foods[1].duplicateMilkNotice).toBeUndefined();

    const sandwichAndTwoGlasses = dedupeIdenticalContainerMilk({
      analysisStatus: "success",
      foods: [
        row("三文治", "sandwich", { unit: "piece", notes: "包裝三文治", portionMin: 1, portionMax: 1 }),
        row("牛奶", "milk", { notes: "左邊玻璃杯" }),
        row("牛奶", "milk", { notes: "右邊玻璃杯" }),
      ],
      uncertaintyReasons: ["餐點有包裝食品。"],
      visibleEvidence: ["包裝三文治", "兩隻杯"],
      estimatedInformation: [],
      unknownInformation: [],
    });
    expect(sandwichAndTwoGlasses.foods).toHaveLength(3);
    expect(sandwichAndTwoGlasses.foods.filter((item) => item.displayName === "牛奶")).toHaveLength(2);
    expect(sandwichAndTwoGlasses.foods.every((item) => item.duplicateMilkNotice == null)).toBe(true);
  });
});
