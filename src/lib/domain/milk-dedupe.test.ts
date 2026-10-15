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

    describe("P1 verified carton cardinality (independent review regressions)", () => {
      const cartons = (amount: number) => Array.from({ length: amount }, () => carton());
      const actualMeal = (actual: number, extra: ObservedFood[] = [glass()]) =>
        toMeal([...cartons(actual), ...extra]);

      it.each([
        ["one real / two model", 1, 2, "一盒燕麥奶"],
        ["two real / two model", 2, 2, "兩盒燕麥奶"],
        ["two real / three model", 2, 3, "兩盒燕麥奶"],
        ["three real / three model", 3, 3, "三盒燕麥奶"],
        ["three real / four model", 3, 4, "三盒燕麥奶"],
        ["two real / three model simplified", 2, 3, "两盒燕麦奶"],
        ["three real / three model english", 3, 3, "three oat milk cartons"],
        ["two real / three model english", 2, 3, "two oat milk cartons"],
        ["two real / three model digit", 2, 3, "2 cartons of oat milk"],
      ] as const)("%s", (_label, actual, reported, evidence) => {
        const rows = [...cartons(reported), glass()];
        const preparedRows = prepared(analysis(rows, { visibleEvidence: [evidence, "一杯全脂牛奶"] }));
        expect(preparedRows.foods).toHaveLength(reported + 1);
        expect(preparedRows.foods.filter(item => item.suspectedDuplicateMilk)).toHaveLength(reported - actual);
        expect(preparedRows.foods.every(item => !item.duplicateMilkNotice)).toBe(true);
        const calculated = toMeal(preparedRows.foods);
        expect(calculated.includedCount).toBe(actual + 1);
        expect(calculated.totalCount).toBe(reported + 1);
        expect(calculated.coverage).toBe(reported === actual ? "complete" : "partial");
        expect(calculated.totals).toEqual(actualMeal(actual).totals);
        expect(preparePhotoMilkAnalysis(preparedRows)).toEqual(preparedRows);
      });

      it.each([
        ["two visible and two model", "兩盒燕麥奶", 2],
        ["three visible but two model", "三盒燕麥奶", 3],
        ["two visible with English count", "two oat milk cartons", 2],
      ] as const)("the two-row path respects positive multiplicity: %s", (_label, evidence, count) => {
        const result = prepared(analysis([...cartons(2)], {
          visibleEvidence: [evidence],
        }));
        expect(result.foods).toHaveLength(2);
        expect(result.foods.every(item => !item.suspectedDuplicateMilk && !item.duplicateMilkNotice)).toBe(true);
        expect(toMeal(result.foods).includedCount).toBe(2);
        expect(toMeal(result.foods).totals).toEqual(toMeal(cartons(2)).totals);
        expect(count).toBeGreaterThanOrEqual(2);
      });

      it("keeps two real oat cartons despite an extra reported carton when another real milk glass exists", () => {
        const rows = [...cartons(3), glass()];
        const actual = prepared(analysis(rows, {
          visibleEvidence: ["實際只有兩盒燕麥奶，另外有一個玻璃杯盛全脂牛奶"],
        }));
        expect(actual.foods).toHaveLength(4);
        expect(actual.foods.filter(item => item.suspectedDuplicateMilk)).toHaveLength(1);
        expect(toMeal(actual.foods).totals).toEqual(actualMeal(2).totals);
        expect(toMeal(actual.foods).coverage).toBe("partial");

        const withIndividualPositions = prepared(analysis([
          oat("左邊一盒燕麥奶", { preparationMethod: "紙盒" }),
          oat("右邊一盒燕麥奶", { preparationMethod: "紙盒" }),
          oat("紙盒燕麥奶", { preparationMethod: "紙盒" }),
          glass(),
        ], { visibleEvidence: ["兩盒燕麥奶及一個玻璃杯"] }));
        expect(withIndividualPositions.foods.filter(item => item.suspectedDuplicateMilk)).toHaveLength(1);
        expect(toMeal(withIndividualPositions.foods).totals).toEqual(actualMeal(2).totals);
      });

      it("does not turn uncertain or contradictory cardinality into extra confirmed rows", () => {
        const uncertain = prepared(analysis([...cartons(3), glass()], {
          visibleEvidence: ["未能確認是否三盒燕麥奶，亦可能只有一盒"],
        }));
        expect(uncertain.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(2);
        expect(toMeal(uncertain.foods).totals).toEqual(actualMeal(1).totals);

        const contradictory = prepared(analysis([...cartons(3), glass()], {
          visibleEvidence: ["一盒燕麥奶", "三盒燕麥奶"],
        }));
        expect(contradictory.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(2);
        expect(toMeal(contradictory.foods).totals).toEqual(actualMeal(1).totals);

        const negated = prepared(analysis([...cartons(3), glass()], {
          visibleEvidence: ["不是三盒燕麥奶"],
        }));
        expect(negated.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(2);
      });

      describe("P1 milk-family attribution and evidence-polarity admission", () => {
        it.each([
          ["other soy two cartons, Traditional Chinese", "燕麥奶紙盒，另外兩盒豆漿，旁邊一杯全脂牛奶"],
          ["other soy three cartons, Traditional Chinese", "相片中見到燕麥奶紙盒，旁邊三盒豆漿及玻璃杯牛奶"],
          ["other almond cartons, Traditional Chinese", "燕麥奶紙盒，另外兩盒杏仁奶及一杯全脂牛奶"],
          ["other soy two cartons, English", "oat milk carton with two cartons of soy milk, and a glass of whole milk"],
          ["other soy two cartons, Simplified Chinese", "一盒燕麦奶，旁边两盒豆浆和一杯牛奶"],
        ] as const)("ignores count for a different milk family absent from model foods: %s", (_description, evidence) => {
          const out = prepared(analysis([...cartons(3), glass()], { visibleEvidence: [evidence] }));
          expect(out.foods).toHaveLength(4);
          expect(out.foods.filter(item => item.normalizedName === "oat milk" && item.suspectedDuplicateMilk)).toHaveLength(2);
          expect(out.foods.find(item => item.normalizedName === "whole milk")?.suspectedDuplicateMilk).toBeUndefined();
          const actual = toMeal(out.foods);
          expect(actual.coverage).toBe("partial");
          expect(actual.includedCount).toBe(2);
          expect(actual.totals).toEqual(actualMeal(1).totals);
          expect(preparePhotoMilkAnalysis(out)).toEqual(out);
        });

        it.each([
          "沒有三盒燕麥奶",
          "未見三盒燕麥奶",
          "没看到三盒燕麦奶",
          "no three oat milk cartons",
          "without three oat milk cartons",
          "三盒燕麥奶？",
          "three oat milk cartons?",
          "是否三盒燕麥奶",
          "可能有三盒燕麥奶",
        ])("does not admit negative, uncertain or questioned quantity: %s", evidence => {
          const out = prepared(analysis([...cartons(3), glass()], { visibleEvidence: [evidence] }));
          expect(out.foods.filter(item => item.suspectedDuplicateMilk)).toHaveLength(2);
          const actual = toMeal(out.foods);
          expect(actual.includedCount).toBe(2);
          expect(actual.coverage).toBe("partial");
          expect(actual.totals).toEqual(actualMeal(1).totals);
        });

        it.each([
          "沒有另一盒燕麥奶",
          "燕麥奶，另一盒？",
          "not another oat milk carton",
        ])("does not admit model-row negative or uncertain second-carton wording: %s", note => {
          const rows = [oat(note, { preparationMethod: "紙盒" }), carton(), glass()];
          const out = prepared(analysis(rows));
          expect(out.foods.filter(item => item.suspectedDuplicateMilk)).toHaveLength(1);
          expect(toMeal(out.foods).totals).toEqual(actualMeal(1).totals);
        });

        it("keeps positive explicit counts in both languages and both attribution orders", () => {
          for (const evidence of [
            "兩盒燕麥奶及一盒豆漿，旁邊有玻璃杯牛奶",
            "2 cartons of oat milk and one carton of soy milk, plus a glass of whole milk",
            "燕麥奶兩盒，豆漿一盒，另有一杯牛奶",
          ]) {
            const soy = oat("豆漿紙盒", {
              displayName: "豆漿", normalizedName: "soy milk", preparationMethod: "紙盒",
            });
            const out = prepared(analysis([...cartons(3), soy, glass()], {
              visibleEvidence: [evidence],
            }));
            expect(out.foods.filter(item => item.normalizedName === "oat milk" && item.suspectedDuplicateMilk), evidence).toHaveLength(1);
            expect(out.foods.find(item => item.normalizedName === "soy milk")?.suspectedDuplicateMilk, evidence).toBeUndefined();
            expect(toMeal(out.foods).includedCount, evidence).toBe(4);
          }
        });

        it("does not treat generalized two cartons of drinks naming oat and soy as two oat cartons", () => {
          const out = prepared(analysis([...cartons(3), glass()], {
            visibleEvidence: ["兩盒飲品：燕麥奶及豆漿；還有一杯牛奶"],
          }));
          expect(out.foods.filter(item => item.suspectedDuplicateMilk)).toHaveLength(2);
          expect(toMeal(out.foods).totals).toEqual(actualMeal(1).totals);
        });
      });

      describe("P1 non-numeric vessel identity and spatial scope", () => {
        const oatCarton = (note: string) => oat(note, { preparationMethod: "紙盒" });
        const oneOatPlusGlass = () => toMeal([oatCarton("紙盒燕麥奶"), glass()]);
        it.each([
          ["another glass in oat row", "燕麥奶紙盒，旁邊另一杯", "一盒燕麥奶，獨立玻璃杯"],
          ["different cup without identity", "紙盒燕麥奶；前方玻璃杯，後方另一杯", "燕麥奶紙盒與玻璃杯"],
          ["unlabelled different carton", "燕麥奶紙盒，另一盒未標示身份", "獨立玻璃杯"],
          ["another carton unknown", "一盒燕麥奶；另一盒飲品無品牌", "相片中有一盒燕麥奶與另一盒不同飲品"],
          ["English other glass", "oat milk carton next to another glass", "one oat carton, one glass of whole milk"],
          ["negative other oat carton", "燕麥奶紙盒，並沒有另一盒燕麥奶", "燕麥奶只有一盒"],
          ["questioned other oat carton", "燕麥奶紙盒，另一盒燕麥奶？", "一盒燕麥奶可辨"],
          ["two glasses only in duplicate notes", "燕麥奶紙盒，前方杯子後方另一杯", "實際只見一盒燕麥奶"],
        ] as const)("does not count a different vessel as another oat carton: %s", (_name, note, evidence) => {
          const output = prepared(analysis([oatCarton(note), oatCarton(note), glass()], { visibleEvidence: [evidence] }));
          expect(output.foods).toHaveLength(3);
          expect(output.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(1);
          expect(output.foods.find(x => x.normalizedName === "whole milk")?.suspectedDuplicateMilk).toBeUndefined();
          const actual = toMeal(output.foods);
          expect(actual.coverage).toBe("partial");
          expect(actual.includedCount).toBe(2);
          expect(actual.totalCount).toBe(3);
          expect(actual.totals).toEqual(oneOatPlusGlass().totals);
          expect(preparePhotoMilkAnalysis(output)).toEqual(output);
        });

        it.each([
          ["explicit another same-family carton", "一盒燕麥奶，旁邊另一盒燕麥奶", "一杯全脂牛奶"],
          ["explicit another oat carton English", "oat milk carton and another carton of oat milk", "a glass of milk"],
          ["second oat carton", "紙盒燕麥奶，第二盒燕麥奶", "另一杯牛奶"],
        ] as const)("counts two explicitly identified oat cartons: %s", (_name, note, evidence) => {
          const output = prepared(analysis([oatCarton(note), oatCarton(note), glass()], { visibleEvidence: [evidence] }));
          expect(output.foods).toHaveLength(3);
          expect(output.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(0);
          expect(toMeal(output.foods).totals).toEqual(toMeal([oatCarton(note), oatCarton(note), glass()]).totals);
        });

        it.each([
          ["left/right cartons", "左邊燕麥奶紙盒", "右邊燕麥奶紙盒"],
          ["front/back cartons", "前方紙盒燕麥奶", "後方紙盒燕麥奶"],
          ["left/right English", "left oat milk carton", "right oat milk carton"],
        ] as const)("counts two distinctly located and identified oat cartons: %s", (_name, left, right) => {
          const output = prepared(analysis([oatCarton(left), oatCarton(right), glass()]));
          expect(output.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(0);
          expect(toMeal(output.foods).includedCount).toBe(3);
        });

        it("does not mistake duplicated notes describing both positioned cartons as independent model rows", () => {
          const note = "左邊燕麥奶紙盒，右邊燕麥奶紙盒";
          const output = prepared(analysis([oatCarton(note), oatCarton(note), glass()]));
          expect(output.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(1);
          expect(toMeal(output.foods).totals).toEqual(oneOatPlusGlass().totals);
        });

        it("does not inflate milk count if non-numeric evidence belongs to another family", () => {
          const output = prepared(analysis([
            oatCarton("燕麥奶紙盒，另一盒豆漿"),
            oatCarton("燕麥奶紙盒，另一盒豆漿"),
            glass(),
          ]));
          expect(output.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(1);
          expect(toMeal(output.foods).totals).toEqual(oneOatPlusGlass().totals);
        });

        it.each([
          ["glass only in duplicate oat-row notes", "燕麥奶紙盒，旁邊另一杯", 1],
          ["unidentified carton only in duplicate row notes", "燕麥奶紙盒，另一盒未標示身份", 1],
          ["duplicated both-sided note", "左邊燕麥奶紙盒，右邊燕麥奶紙盒", 1],
          ["genuinely distinct another oat carton", "燕麥奶紙盒，另一盒燕麥奶", 2],
        ] as const)("two AI milk rows apply the same vessel-scope safety: %s", (_label, note, count) => {
          const out = prepared(analysis([oatCarton(note), oatCarton(note)]));
          expect(out.foods.filter(x => !x.suspectedDuplicateMilk)).toHaveLength(count);
          if (count === 1) {
            expect(out.foods).toHaveLength(2);
            expect(out.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(1);
            expect(toMeal(out.foods).coverage).toBe("partial");
            expect(toMeal(out.foods).totals).toEqual(toMeal([oatCarton(note)]).totals);
          }
        });

        it("respects interleaved row order and never holds the genuine glass pending", () => {
          const notes = "燕麥奶紙盒，旁邊另一杯";
          const all = [glass(), oatCarton(notes), oatCarton(notes)];
          const output = prepared(analysis(all));
          expect(output.foods[0].suspectedDuplicateMilk).toBeUndefined();
          expect(output.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(1);
          expect(toMeal(output.foods).totals).toEqual(oneOatPlusGlass().totals);
        });

        it.each([
          ["燕麥奶紙盒，旁邊另一杯", "燕麥奶紙盒，旁邊玻璃杯"],
          ["紙盒燕麥奶，旁邊另一杯", "燕麥奶紙盒，另有玻璃杯"],
          ["oat milk carton, another glass nearby", "燕麥奶紙盒，旁邊玻璃杯"],
          ["燕麥奶紙盒；前方另一杯", "燕麥奶紙盒，後方玻璃杯"],
          ["紙盒燕麥奶，旁邊未標示的杯子", "燕麥奶紙盒，另一杯"],
          ["燕麥奶紙盒，旁邊玻璃杯", "燕麥奶紙盒，旁邊另一杯"],
        ] as const)("two-row differing notes still withhold duplicate oat cartons: %s / %s", (left, right) => {
          for (const foods of [[oatCarton(left), oatCarton(right)], [oatCarton(right), oatCarton(left)]]) {
            const output = prepared(analysis(foods));
            expect(output.foods).toHaveLength(2);
            expect(output.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(1);
            expect(toMeal(output.foods).includedCount).toBe(1);
            expect(toMeal(output.foods).coverage).toBe("partial");
          }
        });

        it.each([
          ["紙盒燕麥奶，與旁邊玻璃杯不是同一杯", "紙盒燕麥奶"],
          ["紙盒燕麥奶，不是同一杯", "紙盒燕麥奶"],
          ["oat milk carton, not the same glass", "oat milk carton"],
          ["燕麦奶纸盒，不是同一杯", "燕麦奶纸盒"],
          ["紙盒燕麥奶，並非同一玻璃杯", "紙盒燕麥奶"],
        ] as const)("negated glass sameness never proves two oat cartons: %s", (left, right) => {
          const output = prepared(analysis([oatCarton(left), oatCarton(right)]));
          expect(output.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(1);
          expect(toMeal(output.foods).includedCount).toBe(1);
        });

        it.each([
          ["不是同一紙盒", "紙盒燕麥奶"],
          ["not the same carton", "oat milk carton"],
          ["並非同一纸盒", "燕麦奶纸盒"],
        ] as const)("negated carton sameness can still keep two oat rows active: %s", (evidence, note) => {
          const output = prepared(analysis([oatCarton(note), oatCarton(note)], {
            visibleEvidence: [evidence],
          }));
          expect(output.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(0);
          expect(toMeal(output.foods).includedCount).toBe(2);
        });

        it("counts one oat and one dairy when duplicate oat notes differ but a glass row exists", () => {
          const output = prepared(analysis([
            oatCarton("燕麥奶紙盒，旁邊另一杯"),
            oatCarton("燕麥奶紙盒，旁邊玻璃杯"),
            glass(),
          ]));
          expect(output.foods.filter(x => x.normalizedName === "oat milk" && x.suspectedDuplicateMilk)).toHaveLength(1);
          expect(output.foods.find(x => x.normalizedName === "whole milk")?.suspectedDuplicateMilk).toBeUndefined();
          expect(toMeal(output.foods).includedCount).toBe(2);
        });
      });

      it("does not count a noted other soy carton as a second oat carton", () => {
        const first = oat("一盒燕麥奶，旁邊另一盒豆漿", { preparationMethod: "紙盒" });
        const soy = oat("另一盒豆漿", {
          displayName: "豆漿", normalizedName: "soy milk", preparationMethod: "紙盒",
        });
        const out = prepared(analysis([first, carton(), soy, glass()], {
          visibleEvidence: ["燕麥奶與豆漿各一盒，旁邊一杯全脂牛奶"],
        }));
        expect(out.foods.filter(x => x.normalizedName === "oat milk" && x.suspectedDuplicateMilk)).toHaveLength(1);
        expect(toMeal(out.foods).includedCount).toBe(3);
      });

      it("does not treat uncertain negation as proof of a second carton", () => {
        const out = prepared(analysis([
          oat("可能不是同一紙盒", { preparationMethod: "紙盒" }),
          carton(), carton(), glass(),
        ]));
        expect(out.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(2);
      });

      it("cannot assign meal-level carton counts to the wrong milk family", () => {
        const soy = oat("另一盒豆漿", {
          displayName: "豆漿", normalizedName: "soy milk", preparationMethod: "紙盒",
        });
        const output = prepared(analysis([...cartons(3), soy, glass()], {
          visibleEvidence: ["畫面有兩盒飲品：燕麥奶及豆漿，旁邊一杯牛奶"],
        }));
        expect(output.foods.filter(x => x.normalizedName === "oat milk" && x.suspectedDuplicateMilk)).toHaveLength(2);
        expect(output.foods.find(x => x.normalizedName === "soy milk")?.suspectedDuplicateMilk).toBeUndefined();
        expect(output.foods.find(x => x.normalizedName === "whole milk")?.suspectedDuplicateMilk).toBeUndefined();
      });

      it("recognizes each explicitly attributed count in the same statement across milk families", () => {
        const soy = oat("紙盒豆漿", {
          displayName: "豆漿", normalizedName: "soy milk", preparationMethod: "紙盒",
        });
        const result = prepared(analysis([...cartons(3), soy, glass()], {
          visibleEvidence: ["兩盒燕麥奶及一盒豆漿，一杯全脂牛奶"],
        }));
        expect(result.foods.filter(x => x.suspectedDuplicateMilk)).toHaveLength(1);
        expect(result.foods.find(x => x.normalizedName === "soy milk")?.suspectedDuplicateMilk).toBeUndefined();
      });

      it("honors explicit three carton multiplicity even when notes individually say one carton", () => {
        const result = prepared(analysis([...cartons(3), glass()], {
          visibleEvidence: ["三盒燕麥奶", "旁邊獨立玻璃杯"],
        }));
        expect(result.foods).toHaveLength(4);
        expect(result.foods.every(x => !x.suspectedDuplicateMilk && !x.duplicateMilkNotice)).toBe(true);
        expect(toMeal(result.foods).totals).toEqual(actualMeal(3).totals);
      });
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
