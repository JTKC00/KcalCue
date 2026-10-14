import { describe, expect, it } from "vitest";

import { foodAnalysisSchema } from "@/lib/domain/food-analysis";
import {
  MERGED_DUPLICATE_MILK_NOTICE,
  SUSPECTED_DUPLICATE_MILK_NOTICE,
  dedupeIdenticalContainerMilk,
} from "@/lib/domain/milk-dedupe";
import { PLANT_MILK_PHOTO_NOTICE, preparePhotoMilkAnalysis } from "@/lib/domain/photo-milk-analysis";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { roundRange } from "@/lib/nutrition/calculation";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { NutritionService } from "@/lib/nutrition/service";
import { duplicateGenericMilkCartonAnalysis } from "@/lib/nutrition/duplicate-milk-carton.fixture";
import { productionGlassMilkUnknownAnalysis } from "@/lib/nutrition/photo-milk-prod-qa.fixture";
import { qaSuspectedMilkAnalysis } from "@/lib/domain/qa-suspected-milk";
import {
  c3Run1SingleOatCartonAnalysis,
  c3Run2SingleOatCartonAnalysis,
  c4TwoMilkContainersAnalysis,
  m6CartonAndGlassAnalysis,
} from "@/lib/nutrition/m7-milk-dedupe.fixture";
import type { FoodAnalysis, ObservedFood } from "@/lib/domain/food-analysis";

function oat(note: string, extra: Partial<ObservedFood> = {}): ObservedFood {
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
    notes: note,
    ...extra,
  };
}

function analysis(foods: ObservedFood[], extra: Partial<FoodAnalysis> = {}): FoodAnalysis {
  return {
    analysisStatus: "success",
    foods,
    uncertaintyReasons: [],
    visibleEvidence: [],
    estimatedInformation: [],
    unknownInformation: [],
    ...extra,
  };
}

function prepared(value: FoodAnalysis) {
  return preparePhotoMilkAnalysis(foodAnalysisSchema.parse(value));
}

const provider = new LocalNutritionProvider();
const service = new NutritionService(provider);

describe("issue 127 milk duplicate matrix", () => {
  it("holds the QA fixture's second whole-milk row out of the confirmed total", () => {
    const held = prepared(qaSuspectedMilkAnalysis);
    expect(held.foods).toHaveLength(2);
    expect(held.foods[0].displayName).toBe("全脂牛奶");
    expect(held.foods[0].suspectedDuplicateMilk).toBeUndefined();
    expect(held.foods[1].suspectedDuplicateMilk).toBe(true);
    expect(preparePhotoMilkAnalysis(held)).toEqual(held);
    const items = createEditableFoodItems(held.foods).map(item => ({
      ...item,
      entrySource: "photo" as const,
    }));
    const meal = service.calculateMeal(items);
    expect(meal.includedCount).toBe(1);
    expect(meal.totalCount).toBe(2);
    expect(meal.coverage).toBe("partial");
    expect(roundRange(meal.totals.calories, 5)).toEqual({ min: 155, max: 160 });
    const separate = items.map(item => {
      if (item.suspectedDuplicateMilk !== true) return item;
      const next = { ...item };
      delete next.suspectedDuplicateMilk;
      return next;
    });
    expect(service.calculateMeal(separate).includedCount).toBe(2);
    expect(roundRange(service.calculateMeal(separate).totals.calories, 5)).toEqual({ min: 310, max: 315 });
  });

  it("(a) merges the same canonical key on the same container when nothing says there is a second container", () => {
    const merged = prepared(c3Run1SingleOatCartonAnalysis);
    expect(c3Run1SingleOatCartonAnalysis.foods).toHaveLength(2);
    expect(merged.foods).toHaveLength(1);
    expect(merged.foods[0]).toMatchObject({
      displayName: "燕麥奶",
      normalizedName: "oat milk",
      recognitionConfidence: 0.99,
      notes: "包裝可讀到「OATLY」、「THE ORIGINAL」、「WATER HAVER BARISTA EDITION」、「100% cool for vegans」及「1L」；標示為燕麥奶飲品。",
      duplicateMilkNotice: MERGED_DUPLICATE_MILK_NOTICE,
      otherMilkNotice: PLANT_MILK_PHOTO_NOTICE,
    });
    expect(merged.foods[0].suspectedDuplicateMilk).toBeUndefined();
    expect(merged.foods.filter(food => food.suspectedDuplicateMilk === true)).toHaveLength(0);
    expect(foodAnalysisSchema.parse(merged).foods[0].duplicateMilkNotice).toBe(MERGED_DUPLICATE_MILK_NOTICE);

    const explicit = dedupeIdenticalContainerMilk(duplicateGenericMilkCartonAnalysis);
    expect(explicit.foods).toHaveLength(1);
    expect(explicit.foods[0].duplicateMilkNotice).toBe(MERGED_DUPLICATE_MILK_NOTICE);
  });

  it("(b) holds a same-family pair that lacks shared-container evidence out of the confirmed total", () => {
    const unpacked = prepared(analysis([
      oat("紙盒燕麥奶", { preparationMethod: "紙盒", displayName: "紙盒燕麥奶" }),
      oat("白色飲品"),
    ]));
    expect(unpacked.foods).toHaveLength(2);
    expect(unpacked.foods[0].suspectedDuplicateMilk).toBeUndefined();
    expect(unpacked.foods[0].duplicateMilkNotice).toBeUndefined();
    expect(unpacked.foods[1].suspectedDuplicateMilk).toBe(true);
    expect(unpacked.foods[1].duplicateMilkNotice).toBeUndefined();

    const items = createEditableFoodItems(unpacked.foods).map(item => ({
      ...item,
      entrySource: "photo" as const,
      userMilkTypeChoice: "oat" as const,
    }));
    const meal = service.calculateMeal(items);
    const one = service.calculateMeal([items[0]]);
    const both = service.calculateMeal(items.map(item => {
      const separate: typeof item = { ...item };
      delete separate.suspectedDuplicateMilk;
      return separate;
    }));
    expect(meal.includedCount).toBe(1);
    expect(meal.totalCount).toBe(2);
    expect(meal.coverage).toBe("partial");
    expect(meal.totals.calories).toEqual(one.totals.calories);
    expect(meal.totals.calories.max).toBeLessThan(both.totals.calories.max);
    expect(roundRange(meal.totals.calories, 5)).toEqual({ min: 115, max: 120 });
    const suspected = items[1];
    if (suspected.portionMin === null || suspected.portionMax === null) throw new Error("portion");
    const suspectedMatch = provider.resolve({
      ...suspected,
      portionMin: suspected.portionMin,
      portionMax: suspected.portionMax,
    });
    expect(suspectedMatch.includedInTotal).toBe(false);
    expect(suspectedMatch.reasons[0]).toBe(SUSPECTED_DUPLICATE_MILK_NOTICE);

    const confirmed = items.map(item => {
      if (item.suspectedDuplicateMilk !== true) return item;
      const separate: typeof item = { ...item, nutritionMatch: null };
      delete separate.suspectedDuplicateMilk;
      return separate;
    });
    const after = service.calculateMeal(confirmed);
    expect(after.includedCount).toBe(2);
    expect(after.totals.calories).toEqual(both.totals.calories);
  });

  it("(c) keeps M6 carton plus a separate glass as two counting rows", () => {
    const distinct = prepared(m6CartonAndGlassAnalysis);
    expect(distinct.foods.map(food => food.displayName)).toEqual(["燕麥奶", "牛奶"]);
    expect(distinct.foods.every(food => food.duplicateMilkNotice == null)).toBe(true);
    expect(distinct.foods.every(food => food.suspectedDuplicateMilk == null)).toBe(true);
  });

  it("(d) keeps two cartons when the model says there are two", () => {
    const two = prepared(analysis(
      [oat("左邊一盒"), oat("另一盒")],
      { visibleEvidence: ["兩盒燕麥奶"] },
    ));
    expect(two.foods).toHaveLength(2);
    expect(two.foods.every(food => food.duplicateMilkNotice == null)).toBe(true);
    expect(two.foods.every(food => food.suspectedDuplicateMilk == null)).toBe(true);
    const items = createEditableFoodItems(two.foods).map(item => ({
      ...item,
      entrySource: "photo" as const,
      userMilkTypeChoice: "oat" as const,
    }));
    expect(service.calculateMeal(items).includedCount).toBe(2);
  });

  it("does not count two identical carton rows when only the meal text mentions a glass", () => {
    const held = prepared(analysis(
      [
        oat("紙盒燕麥奶", { preparationMethod: "紙盒" }),
        oat("紙盒燕麥奶", { preparationMethod: "紙盒" }),
      ],
      { visibleEvidence: ["旁邊有一個玻璃杯"] },
    ));
    expect(held.foods).toHaveLength(2);
    expect(held.foods.filter(food => food.suspectedDuplicateMilk === true)).toHaveLength(1);
    expect(held.foods.every(food => food.duplicateMilkNotice == null)).toBe(true);
    const items = createEditableFoodItems(held.foods).map(item => ({
      ...item,
      entrySource: "photo" as const,
      userMilkTypeChoice: "oat" as const,
    }));
    expect(service.calculateMeal(items).includedCount).toBe(1);

    const frontAndBack = prepared(analysis(
      [oat("紙盒", { preparationMethod: "紙盒" }), oat("紙盒", { preparationMethod: "紙盒" })],
      { visibleEvidence: ["前方玻璃杯", "後方紙盒"] },
    ));
    expect(frontAndBack.foods.filter(food => food.suspectedDuplicateMilk === true)).toHaveLength(1);
    const frontItems = createEditableFoodItems(frontAndBack.foods).map(item => ({
      ...item,
      entrySource: "photo" as const,
      userMilkTypeChoice: "oat" as const,
    }));
    expect(service.calculateMeal(frontItems).includedCount).toBe(1);
  });

  it("(e) does not treat uncertain or negated same-serving wording as a merge", () => {
    const uncertain = prepared(analysis(
      [oat("紙盒", { preparationMethod: "紙盒" }), oat("紙盒", { preparationMethod: "紙盒" })],
      { visibleEvidence: ["未能確認是否同一紙盒"] },
    ));
    expect(uncertain.foods).toHaveLength(2);
    expect(uncertain.foods.some(food => food.suspectedDuplicateMilk === true)).toBe(true);
    expect(uncertain.foods.every(food => food.duplicateMilkNotice == null)).toBe(true);
    const uncertainItems = createEditableFoodItems(uncertain.foods).map(item => ({
      ...item,
      entrySource: "photo" as const,
      userMilkTypeChoice: "oat" as const,
    }));
    expect(service.calculateMeal(uncertainItems).includedCount).toBe(1);

    const negated = prepared(analysis(
      [oat("紙盒", { preparationMethod: "紙盒" }), oat("紙盒", { preparationMethod: "紙盒" })],
      { visibleEvidence: ["not the same carton"] },
    ));
    expect(negated.foods).toHaveLength(2);
    expect(negated.foods.every(food => food.suspectedDuplicateMilk == null)).toBe(true);
    expect(negated.foods.every(food => food.duplicateMilkNotice == null)).toBe(true);
    const negatedItems = createEditableFoodItems(negated.foods).map(item => ({
      ...item,
      entrySource: "photo" as const,
      userMilkTypeChoice: "oat" as const,
    }));
    expect(service.calculateMeal(negatedItems).includedCount).toBe(2);
  });

  it("(f) merges varied notes in either order when the container is still the same one", () => {
    const first = oat("相片只顯示一盒燕麥奶");
    const second = oat("盒裝燕麥奶，畫面中只有這一項", { preparationMethod: "盒裝" });
    for (const foods of [[first, second], [second, first]]) {
      const merged = prepared(analysis(foods));
      expect(merged.foods).toHaveLength(1);
      expect(merged.foods[0].duplicateMilkNotice).toBe(MERGED_DUPLICATE_MILK_NOTICE);
      expect(merged.foods[0].suspectedDuplicateMilk).toBeUndefined();
    }
  });

  it("(g) leaves a single row without a duplicate notice", () => {
    const single = prepared(c3Run2SingleOatCartonAnalysis);
    expect(single.foods).toHaveLength(1);
    expect(single.foods[0].duplicateMilkNotice).toBeUndefined();
    expect(single.foods[0].suspectedDuplicateMilk).toBeUndefined();
    expect(single.foods[0].otherMilkNotice).toBe(PLANT_MILK_PHOTO_NOTICE);
    expect(single.foods[0].displayName).toBe("燕麥奶");
    expect(single.foods[0].notes).toContain("包裝顯示為燕麥奶");
  });

  it("keeps C4's two described containers and drops the plant notice when no label is visible", () => {
    expect(c4TwoMilkContainersAnalysis.foods.every(food => food.otherMilkNotice === PLANT_MILK_PHOTO_NOTICE)).toBe(true);
    const distinct = prepared(c4TwoMilkContainersAnalysis);
    expect(distinct.foods).toHaveLength(2);
    expect(distinct.foods.map(food => [food.portionMin, food.portionMax])).toEqual([[250, 400], [200, 350]]);
    expect(distinct.foods.every(food => food.duplicateMilkNotice == null)).toBe(true);
    expect(distinct.foods.every(food => food.suspectedDuplicateMilk == null)).toBe(true);
    expect(distinct.foods.every(food => food.otherMilkNotice == null)).toBe(true);
  });

  it("sets the plant-milk notice only when a statement cites both packaging and plant milk", () => {
    const labelled = prepared(analysis([
      oat("冷藏飲品", { displayName: "牛奶", normalizedName: "milk", notes: "未能讀到品牌" }),
    ], { visibleEvidence: ["紙盒寫有燕麥奶"] }));
    expect(labelled.foods[0].otherMilkNotice).toBe(PLANT_MILK_PHOTO_NOTICE);

    const namedOnly = prepared(analysis([oat("透明玻璃杯", { preparationMethod: "杯裝" })]));
    expect(namedOnly.foods[0].otherMilkNotice).toBeUndefined();

    const unlabelledGuess = prepared(analysis([
      oat("玻璃杯", {
        displayName: "牛奶",
        normalizedName: "milk",
        preparationMethod: "杯裝",
      }),
    ], {
      uncertaintyReasons: ["可能是植物奶"],
      unknownInformation: ["未能確認是否為牛奶、植物奶或其他白色飲品。"],
    }));
    expect(unlabelledGuess.foods[0].otherMilkNotice).toBeUndefined();

    const negatedLabel = prepared(analysis([
      oat("玻璃杯", {
        displayName: "牛奶",
        normalizedName: "milk",
        preparationMethod: "杯裝",
        uncertaintyReasons: ["白色飲品沒有可見標籤，單憑外觀未能確定是牛奶，也可能是植物奶。"],
        notes: "前方透明玻璃杯內可見白色飲品；沒有品牌或包裝文字可供確認。",
        otherMilkNotice: PLANT_MILK_PHOTO_NOTICE,
      }),
    ]));
    expect(negatedLabel.foods[0].otherMilkNotice).toBeUndefined();

    const unlabelledGlass = prepared({
      ...productionGlassMilkUnknownAnalysis,
      foods: [{
        ...productionGlassMilkUnknownAnalysis.foods[0],
        otherMilkNotice: PLANT_MILK_PHOTO_NOTICE,
      }],
    });
    expect(unlabelledGlass.foods[0].otherMilkNotice).toBeUndefined();
  });

  it("repeats the same decision for the masked shapes", () => {
    const shapes = [
      c3Run1SingleOatCartonAnalysis,
      c3Run2SingleOatCartonAnalysis,
      c4TwoMilkContainersAnalysis,
      m6CartonAndGlassAnalysis,
    ];
    for (const shape of shapes) {
      const once = prepared(shape);
      expect(preparePhotoMilkAnalysis(once)).toEqual(once);
      for (let pass = 0; pass < 5; pass += 1) {
        expect(prepared(shape)).toEqual(once);
      }
    }
  });

  describe("P1 group-aware mixed-container deduplication", () => {
    const carton = () => oat("相片中一盒燕麥奶", { preparationMethod: "紙盒" });
    const glass = () => oat("獨立玻璃杯", {
      displayName: "全脂牛奶", normalizedName: "whole milk",
      preparationMethod: "玻璃杯", portionMin: 250, portionMax: 250,
    });
    const toMeal = (foods: ObservedFood[]) => service.calculateMeal(
      createEditableFoodItems(foods).map(item => ({
        ...item, entrySource: "photo" as const,
        userMilkTypeChoice: item.normalizedName === "oat milk" ? "oat" as const : "whole" as const,
      })),
    );

    it.each(["cartons-first", "glass-first", "interleaved"] as const)(
      "never double-counts a duplicated oat carton beside a genuine glass (%s)", order => {
        const foods = order === "glass-first"
          ? [glass(), carton(), carton()]
          : order === "interleaved"
            ? [carton(), glass(), carton()]
            : [carton(), carton(), glass()];
        const result = prepared(analysis(foods, {
          visibleEvidence: ["畫面一盒燕麥奶，另外一個玻璃杯盛全脂牛奶"],
        }));
        expect(result.foods).toHaveLength(3);
        expect(result.foods.filter(item => item.suspectedDuplicateMilk)).toHaveLength(1);
        expect(result.foods.filter(item => item.normalizedName === "whole milk" && item.suspectedDuplicateMilk)).toHaveLength(0);
        const actual = toMeal(result.foods);
        const expected = toMeal([carton(), glass()]);
        expect(actual.includedCount).toBe(2);
        expect(actual.totalCount).toBe(3);
        expect(actual.coverage).toBe("partial");
        expect(actual.totals).toEqual(expected.totals);
        expect(actual.foods.filter(item => item.food.suspectedDuplicateMilk && item.includedInTotal)).toHaveLength(0);
        expect(preparePhotoMilkAnalysis(result)).toEqual(result);
      },
    );

    it("keeps distinct cartons of different milk types plus a glass", () => {
      const soy = oat("紙盒豆漿", {
        displayName: "豆漿", normalizedName: "soy milk", preparationMethod: "紙盒",
      });
      const items = prepared(analysis([carton(), soy, glass()]));
      expect(items.foods).toHaveLength(3);
      expect(items.foods.every(food => !food.suspectedDuplicateMilk && !food.duplicateMilkNotice)).toBe(true);
      expect(toMeal(items.foods).totalCount).toBe(3);
    });

    it("preserves two explicitly distinct oat cartons even next to a glass", () => {
      const items = prepared(analysis([
        oat("左邊一盒燕麥奶", { preparationMethod: "紙盒" }),
        oat("另一盒燕麥奶", { preparationMethod: "紙盒" }),
        glass(),
      ], { visibleEvidence: ["畫面兩盒燕麥奶，旁邊有一杯全脂牛奶"] }));
      expect(items.foods).toHaveLength(3);
      expect(items.foods.every(food => !food.suspectedDuplicateMilk && !food.duplicateMilkNotice)).toBe(true);
      expect(toMeal(items.foods).totalCount).toBe(3);
      expect(toMeal(items.foods).includedCount).toBe(3);
    });

    it("does not interpret a meal-level two-carton count as two oat cartons when the second is soy", () => {
      const soy = oat("另一盒豆漿", {
        displayName: "豆漿", normalizedName: "soy milk", preparationMethod: "紙盒",
      });
      const items = prepared(analysis([carton(), carton(), soy, glass()], {
        visibleEvidence: ["畫面有兩盒飲品：燕麥奶及豆漿，旁邊另有玻璃杯"],
      }));
      expect(items.foods).toHaveLength(4);
      expect(items.foods.filter(food => food.normalizedName === "oat milk" && food.suspectedDuplicateMilk)).toHaveLength(1);
      expect(items.foods.find(food => food.normalizedName === "soy milk")?.suspectedDuplicateMilk).toBeUndefined();
      expect(items.foods.find(food => food.normalizedName === "whole milk")?.suspectedDuplicateMilk).toBeUndefined();
      expect(toMeal(items.foods).includedCount).toBe(3);
      expect(toMeal(items.foods).coverage).toBe("partial");
    });

    it("withholds an unknown-kind milk row when its carton family is unambiguous", () => {
      const genericCarton = oat("紙盒白色飲品", {
        displayName: "牛奶", normalizedName: "milk", preparationMethod: "紙盒",
      });
      const items = prepared(analysis([carton(), genericCarton, glass()]));
      expect(items.foods).toHaveLength(3);
      expect(items.foods.filter(food => food.suspectedDuplicateMilk)).toHaveLength(1);
      expect(items.foods.find(food => food.normalizedName === "whole milk")?.suspectedDuplicateMilk).toBeUndefined();
    });

    it("leaves unresolved carton variants visible rather than merging by a glass's evidence", () => {
      const variant = oat("紙盒燕麥奶，旁邊另有玻璃杯", { preparationMethod: "紙盒" });
      const items = prepared(analysis([carton(), variant, glass()], {
        visibleEvidence: ["盒裝燕麥奶和獨立玻璃杯"],
      }));
      expect(items.foods).toHaveLength(3);
      expect(items.foods.filter(food => food.suspectedDuplicateMilk)).toHaveLength(1);
    });

    it("preserves specific uncertain/negated evidence for two separate cartons", () => {
      const uncertain = prepared(analysis([
        oat("未能確認是否同一紙盒", { preparationMethod: "紙盒" }),
        carton(), glass(),
      ]));
      expect(uncertain.foods.filter(food => food.suspectedDuplicateMilk)).toHaveLength(1);
      const negated = prepared(analysis([
        oat("not the same carton", { preparationMethod: "紙盒" }),
        carton(), glass(),
      ]));
      expect(negated.foods.filter(food => food.suspectedDuplicateMilk)).toHaveLength(0);
    });

    it("holds out both extra cartons if the same oat container is returned three times with a glass", () => {
      const result = prepared(analysis([carton(), carton(), glass(), carton()], {
        visibleEvidence: ["一盒燕麥奶和一杯全脂牛奶"],
      }));
      expect(result.foods).toHaveLength(4);
      expect(result.foods.filter(food => food.suspectedDuplicateMilk)).toHaveLength(2);
      expect(toMeal(result.foods).totals).toEqual(toMeal([carton(), glass()]).totals);
      expect(toMeal(result.foods).coverage).toBe("partial");
    });
  });

});
