import { describe, expect, it } from "vitest";

import {
  collectUncertaintyReasons,
  confidenceLevel,
  foodConfidence,
  mealConfidence,
} from "./confidence";
import {
  applyPortionPreset,
  convertPortionUnit,
  createEditableFoodItems,
} from "./editable-meal";
import {
  foodAnalysisJsonSchema,
  validateFoodAnalysis,
  type FoodAnalysis,
  type FoodEstimate,
} from "./food-analysis";

function makeFood(overrides: Partial<FoodEstimate> = {}): FoodEstimate {
  return {
    displayName: "白飯",
    normalizedName: "cooked white rice",
    portionMin: 100,
    portionMax: 150,
    unit: "g",
    recognitionConfidence: 0.9,
    portionConfidence: 0.7,
    uncertaintyReasons: ["份量只能從相片估算。"],
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<FoodAnalysis> = {}): FoodAnalysis {
  return {
    analysisStatus: "success",
    foods: [makeFood()],
    uncertaintyReasons: ["相片光線較暗。"],
    visibleEvidence: ["可見一碗白飯。"],
    estimatedInformation: ["重量是視覺估算。"],
    unknownInformation: ["實際重量不明。"],
    ...overrides,
  };
}

describe("confidence mapping", () => {
  it.each([
    [1, "high"],
    [0.8, "high"],
    [0.799, "medium"],
    [0.55, "medium"],
    [0.549, "low"],
    [0, "low"],
  ] as const)("maps score %s to %s", (score, expected) => {
    expect(confidenceLevel(score)).toBe(expected);
  });

  it("uses the weaker recognition or portion score for a food and meal", () => {
    const confidentFood = makeFood({
      recognitionConfidence: 0.95,
      portionConfidence: 0.82,
    });
    const uncertainFood = makeFood({
      displayName: "醬汁",
      normalizedName: "savory sauce",
      recognitionConfidence: 0.68,
      portionConfidence: 0.48,
    });

    expect(foodConfidence(confidentFood)).toBe("high");
    expect(foodConfidence(uncertainFood)).toBe("low");
    expect(mealConfidence([confidentFood, uncertainFood])).toBe("low");
    expect(mealConfidence([])).toBe("low");
  });
});

describe("uncertainty handling", () => {
  it("collects reasons from every level and removes blank or duplicate text", () => {
    const analysis = makeAnalysis({
      uncertaintyReasons: ["相片光線較暗。", "共同原因"],
      unknownInformation: [" 共同原因 ", "實際重量不明。"],
      foods: [
        makeFood({
          uncertaintyReasons: ["份量只能從相片估算。", "相片光線較暗。"],
        }),
      ],
    });

    expect(collectUncertaintyReasons(analysis)).toEqual([
      "相片光線較暗。",
      "共同原因",
      "實際重量不明。",
      "份量只能從相片估算。",
    ]);
  });

  it("supplies a truthful fallback when the structured result has no reasons", () => {
    const analysis = makeAnalysis({
      uncertaintyReasons: [],
      unknownInformation: [],
      foods: [makeFood({ uncertaintyReasons: [] })],
    });

    expect(collectUncertaintyReasons(analysis)).toEqual([
      "相片無法提供食物的實際重量及完整烹調資料。",
    ]);
  });
});

describe("portion adjustment", () => {
  it("preserves the original estimate and applies presets from that baseline", () => {
    const [editable] = createEditableFoodItems([
      makeFood({
        normalizedName: "grilled chicken thigh",
        portionMin: 141,
        portionMax: 179,
      }),
    ]);

    expect(editable).toMatchObject({
      id: "0-grilled-chicken-thigh",
      originalPortionMin: 141,
      originalPortionMax: 179,
    });

    const smaller = applyPortionPreset(editable, "small");
    const largerAfterSmall = applyPortionPreset(smaller, "large");

    expect(smaller).toMatchObject({ portionMin: 92, portionMax: 143 });
    expect(largerAfterSmall).toMatchObject({ portionMin: 176, portionMax: 269 });
    expect(largerAfterSmall.originalPortionMin).toBe(141);
    expect(largerAfterSmall.originalPortionMax).toBe(179);
  });

  it("uses tenth-unit precision for countable portions", () => {
    const [editable] = createEditableFoodItems([
      makeFood({ portionMin: 1.25, portionMax: 1.75, unit: "piece" }),
    ]);

    expect(applyPortionPreset(editable, "large")).toMatchObject({
      portionMin: 1.6,
      portionMax: 2.6,
    });
  });

  it("converts editable portions through a nutrition profile", () => {
    const [editable] = createEditableFoodItems([
      makeFood({ portionMin: 100, portionMax: 200, unit: "g" }),
    ]);
    const converted = convertPortionUnit(editable, "bowl", {
      id: "rice",
      displayName: "白飯",
      aliases: [],
      nutrientsPer100g: { calories: 130, protein: 2.7, carbs: 28, fat: 0.3 },
      gramsPerUnit: { g: 1, bowl: 200 },
      dataNotice: "test fixture",
    });

    expect(converted).toMatchObject({
      unit: "bowl",
      portionMin: 0.5,
      portionMax: 1,
      originalPortionMin: 0.5,
      originalPortionMax: 1,
    });
  });
});

describe("structured food analysis validation", () => {
  it("accepts a valid structured analysis", () => {
    expect(validateFoodAnalysis(makeAnalysis())).toEqual(makeAnalysis());
  });

  it("rejects internally inconsistent or out-of-range structured data", () => {
    expect(() =>
      validateFoodAnalysis({ ...makeAnalysis(), foods: [] }),
    ).toThrow(/successful analysis must include at least one food/i);

    expect(() =>
      validateFoodAnalysis({
        ...makeAnalysis(),
        foods: [makeFood({ portionMin: 200, portionMax: 100 })],
      }),
    ).toThrow(/portionMax must be greater than or equal to portionMin/i);

    expect(() =>
      validateFoodAnalysis({
        ...makeAnalysis(),
        foods: [makeFood({ recognitionConfidence: 1.01 })],
      }),
    ).toThrow();

    expect(() =>
      validateFoodAnalysis({
        ...makeAnalysis(),
        analysisStatus: "unable_to_identify",
        foods: [makeFood()],
      }),
    ).toThrow(/cannot include guessed foods/i);

    expect(
      validateFoodAnalysis({
        ...makeAnalysis(),
        analysisStatus: "unable_to_identify",
        foods: [],
      }).foods,
    ).toEqual([]);

    expect(() =>
      validateFoodAnalysis({
        ...makeAnalysis(),
        extraField: "not-allowed",
      }),
    ).toThrow();
  });

  it("keeps Gemini JSON Schema limited to generation-safe keywords", () => {
    const json = JSON.stringify(foodAnalysisJsonSchema);
    expect(json).not.toContain("additionalProperties");
    expect(json).not.toContain("minimum");
    expect(json).not.toContain("maximum");
    expect(json).not.toContain("maxItems");
    expect(foodAnalysisJsonSchema.properties.analysisStatus.enum).toEqual([
      "success",
      "unable_to_identify",
    ]);
    expect(
      foodAnalysisJsonSchema.properties.foods.items.properties.unit.enum,
    ).toEqual(["g", "ml", "piece", "bowl", "cup"]);
  });
});
