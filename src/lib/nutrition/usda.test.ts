import { afterEach, describe, expect, it, vi } from "vitest";

import { clearUsdaCache, UsdaNutritionClient, UsdaNutritionError } from "./usda";

const food = {
  displayName: "banana",
  normalizedName: "banana",
  identityLevel: "ingredient" as const,
  portionMin: 100,
  portionMax: 120,
  unit: "g" as const,
  recognitionConfidence: 0.9,
  portionConfidence: 0.8,
  uncertaintyReasons: [],
};

describe("USDA nutrition client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    clearUsdaCache();
  });

  it("maps a valid FDC payload to a medium-confidence sourced profile", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          foods: [
            {
              fdcId: 1105314,
              description: "Banana, raw",
              dataType: "SR Legacy",
              foodNutrients: [
                { nutrientName: "Energy", nutrientNumber: "208", value: 89, unitName: "kcal" },
                { nutrientName: "Protein", nutrientNumber: "203", value: 1.1, unitName: "g" },
                {
                  nutrientName: "Carbohydrate, by difference",
                  nutrientNumber: "205",
                  value: 22.8,
                  unitName: "g",
                },
                {
                  nutrientName: "Total lipid (fat)",
                  nutrientNumber: "204",
                  value: 0.3,
                  unitName: "g",
                },
              ],
            },
          ],
        }),
      }),
    );

    const match = await new UsdaNutritionClient("test-only-key").resolve(food);

    expect(match.includedInTotal).toBe(true);
    expect(match.confidence).toBe("medium");
    expect(match.profile?.source.provider).toBe("usda-fdc");
    expect(match.profile?.source.sourceId).toBe("1105314");
    expect(match.profile?.nutrientsPer100g.calories).toEqual({ min: 89, max: 89 });
    expect(match.profile?.gramsPerUnit).toEqual({ g: 1, ml: 1 });
    const mlMatch = await new UsdaNutritionClient("test-only-key").resolve({
      ...food,
      unit: "ml",
    });
    expect(mlMatch.includedInTotal).toBe(true);
    expect(JSON.stringify(match)).not.toContain("test-only-key");
  });

  it("rejects kJ-first and saturated-fat-first nutrient lists", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          foods: [
            {
              fdcId: 1105315,
              description: "Banana, raw",
              foodNutrients: [
                { nutrientName: "Energy", nutrientNumber: "268", value: 372, unitName: "kJ" },
                { nutrientName: "Fatty acids, total saturated", nutrientNumber: "606", value: 8, unitName: "g" },
                { nutrientName: "Energy", nutrientNumber: "208", value: 89, unitName: "kcal" },
                { nutrientName: "Protein", nutrientNumber: "203", value: 1.1, unitName: "g" },
                { nutrientName: "Carbohydrate, by difference", nutrientNumber: "205", value: 22.8, unitName: "g" },
                { nutrientName: "Total lipid (fat)", nutrientNumber: "204", value: 0.3, unitName: "g" },
              ],
            },
          ],
        }),
      }),
    );

    const match = await new UsdaNutritionClient("test-only-key").resolve(food);

    expect(match.includedInTotal).toBe(true);
    expect(match.profile?.nutrientsPer100g.calories).toEqual({ min: 89, max: 89 });
    expect(match.profile?.nutrientsPer100g.fat).toEqual({ min: 0.3, max: 0.3 });
  });

  it("does not include a count unit when USDA has no gram factor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          foods: [
            {
              fdcId: 1105316,
              description: "Banana, raw",
              foodNutrients: [
                { nutrientName: "Energy", nutrientNumber: "208", value: 89, unitName: "kcal" },
                { nutrientName: "Protein", nutrientNumber: "203", value: 1.1, unitName: "g" },
                { nutrientName: "Carbohydrate, by difference", nutrientNumber: "205", value: 22.8, unitName: "g" },
                { nutrientName: "Total lipid (fat)", nutrientNumber: "204", value: 0.3, unitName: "g" },
              ],
            },
          ],
        }),
      }),
    );

    const match = await new UsdaNutritionClient("test-only-key").resolve({
      ...food,
      unit: "piece",
    });

    expect(match.profile?.gramsPerUnit).toEqual({ g: 1, ml: 1 });
    expect(match.includedInTotal).toBe(false);
    expect(match.reasons.at(-1)).toContain("piece");
  });

  it("leaves an irrelevant Banana chips hit unresolved", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          foods: [
            {
              fdcId: 1105317,
              description: "Banana chips",
              foodNutrients: [
                { nutrientName: "Energy", nutrientNumber: "208", value: 519, unitName: "kcal" },
                { nutrientName: "Protein", nutrientNumber: "203", value: 2.3, unitName: "g" },
                { nutrientName: "Carbohydrate, by difference", nutrientNumber: "205", value: 58.4, unitName: "g" },
                { nutrientName: "Total lipid (fat)", nutrientNumber: "204", value: 33.6, unitName: "g" },
              ],
            },
          ],
        }),
      }),
    );

    const match = await new UsdaNutritionClient("test-only-key").resolve(food);

    expect(match.profile).toBeNull();
    expect(match.includedInTotal).toBe(false);
    expect(match.matchType).toBe("unresolved");
  });

  it("classifies a timeout as a recoverable USDA error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("Timed out", "TimeoutError")),
    );

    await expect(new UsdaNutritionClient("test-only-key").resolve(food)).rejects.toMatchObject({
      name: "UsdaNutritionError",
      code: "timeout",
    });
  });

  it("classifies HTTP 429 separately from malformed payloads", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    await expect(new UsdaNutritionClient("test-only-key").resolve(food)).rejects.toBeInstanceOf(
      UsdaNutritionError,
    );
    await expect(new UsdaNutritionClient("test-only-key").resolve(food)).rejects.toMatchObject({
      code: "rate_limited",
    });
  });

  it("reuses the in-memory cache so portion edits do not refetch", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        foods: [
          {
            fdcId: 1,
            description: "Banana, raw",
            foodNutrients: [
                { nutrientName: "Energy", nutrientNumber: "208", value: 89, unitName: "kcal" },
              { nutrientName: "Protein", nutrientNumber: "203", value: 1.1, unitName: "g" },
              { nutrientName: "Carbohydrate", nutrientNumber: "205", value: 22.8, unitName: "g" },
              { nutrientName: "Fat", nutrientNumber: "204", value: 0.3, unitName: "g" },
            ],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new UsdaNutritionClient("test-only-key");
    await client.resolve(food);
    await client.resolve({ ...food, portionMin: 140, portionMax: 180 });
    await client.resolve({ ...food, displayName: " banana ", normalizedName: " banana " });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not reuse a cached result for a different normalized food name", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        foods: [
          {
            fdcId: 2,
            description: "Banana, raw",
            foodNutrients: [
              { nutrientName: "Energy", nutrientNumber: "208", value: 89, unitName: "kcal" },
              { nutrientName: "Protein", nutrientNumber: "203", value: 1.1, unitName: "g" },
              { nutrientName: "Carbohydrate", nutrientNumber: "205", value: 22.8, unitName: "g" },
              { nutrientName: "Fat", nutrientNumber: "204", value: 0.3, unitName: "g" },
            ],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new UsdaNutritionClient("test-only-key");
    await client.resolve(food);
    const differentFood = await client.resolve({
      ...food,
      displayName: "banana chips",
      normalizedName: "banana chips",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(differentFood.profile).toBeNull();
    expect(differentFood.includedInTotal).toBe(false);
  });

  it("does not query USDA for a composite dish", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const match = await new UsdaNutritionClient("test-only-key").resolve({
      displayName: "墨魚汁意大利飯",
      normalizedName: "squid ink risotto",
      identityLevel: "dish" as const,
      portionMin: 180,
      portionMax: 260,
      unit: "g",
      recognitionConfidence: 0.9,
      portionConfidence: 0.7,
      uncertaintyReasons: [],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(match.includedInTotal).toBe(false);
    expect(match.matchType).toBe("unresolved");
    expect(match.profile).toBeNull();
    expect(match.identity.canonicalName).toBe("risotto");
    expect(match.reasons[0]).toContain("不足以代表整道菜");
  });

  it("does not query USDA for fried rice", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const match = await new UsdaNutritionClient("test-only-key").resolve({
      displayName: "炒飯",
      normalizedName: "fried rice",
      identityLevel: "ingredient",
      portionMin: 180,
      portionMax: 260,
      unit: "g",
      recognitionConfidence: 0.9,
      portionConfidence: 0.7,
      uncertaintyReasons: [],
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(match.includedInTotal).toBe(false);
    expect(match.profile).toBeNull();
    expect(match.identity.canonicalName).toBe("fried-rice");
  });
});
