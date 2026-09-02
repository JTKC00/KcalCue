/** @vitest-environment node */

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalizeFood } from "./canonical";
import {
  canReuseNutritionMatchForNameEdit,
  enrichUnresolvedMatches,
} from "./client";
import type { NutritionMatch } from "./types";

const scallops = {
  displayName: "帶子",
  normalizedName: "scallops",
  identityLevel: "ingredient" as const,
  portionMin: 100,
  portionMax: 120,
  unit: "g" as const,
  recognitionConfidence: 0.8,
  portionConfidence: 0.7,
  uncertaintyReasons: [],
};

function cachedUsdaMatch(): NutritionMatch {
  return {
    profile: {
      id: "usda-1",
      displayName: "Scallop, raw",
      canonicalName: "usda-generic",
      category: "unknown",
      preparations: ["unknown"],
      aliases: ["Scallop, raw"],
      composite: false,
      nutrientsPer100g: {
        calories: { min: 69, max: 69 },
        protein: { min: 12.1, max: 12.1 },
        carbs: { min: 3.2, max: 3.2 },
        fat: { min: 0.5, max: 0.5 },
      },
      gramsPerUnit: { g: 1, ml: 1 },
      source: {
        provider: "usda-fdc",
        sourceName: "Scallop, raw",
        attribution: "test",
      },
      dataNotice: "test",
      densityBasis: "test",
    },
    confidence: "medium",
    matchType: "approximate_generic",
    reasons: [],
    identity: canonicalizeFood(scallops),
    includedInTotal: true,
  };
}

describe("nutrition client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps a USDA match for a whitespace-only name edit", () => {
    const currentMatch = cachedUsdaMatch();
    const nextFood = {
      ...scallops,
      displayName: " 帶子 ",
      normalizedName: "scallops",
    };

    expect(
      canReuseNutritionMatchForNameEdit(scallops, nextFood, currentMatch),
    ).toBe(true);
  });

  it("does not reuse a USDA match after a different identity is entered", () => {
    const nextFood = {
      ...scallops,
      displayName: "banana",
      normalizedName: "banana",
    };

    expect(
      canReuseNutritionMatchForNameEdit(scallops, nextFood, cachedUsdaMatch()),
    ).toBe(false);
  });

  it("aligns remote results to unresolved food indexes", async () => {
    const localMatches = [
      cachedUsdaMatch(),
      { ...cachedUsdaMatch(), profile: null, includedInTotal: false },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ matches: [cachedUsdaMatch()] }),
      }),
    );

    const matches = await enrichUnresolvedMatches(
      [scallops, { ...scallops, displayName: "mystery", normalizedName: "mystery" }],
      localMatches,
    );

    expect(matches[0]).toBe(localMatches[0]);
    expect(matches[1]).toEqual(cachedUsdaMatch());
  });
});
