import { afterEach, describe, expect, it, vi } from "vitest";

import { clearUsdaCache, UsdaNutritionClient, UsdaNutritionError } from "./usda";

const food = {
  displayName: "banana",
  normalizedName: "banana",
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
                { nutrientName: "Energy", nutrientNumber: "208", value: 89 },
                { nutrientName: "Protein", nutrientNumber: "203", value: 1.1 },
                { nutrientName: "Carbohydrate, by difference", nutrientNumber: "205", value: 22.8 },
                { nutrientName: "Total lipid (fat)", nutrientNumber: "204", value: 0.3 },
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
    expect(JSON.stringify(match)).not.toContain("test-only-key");
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
              { nutrientName: "Energy", nutrientNumber: "208", value: 89 },
              { nutrientName: "Protein", nutrientNumber: "203", value: 1.1 },
              { nutrientName: "Carbohydrate", nutrientNumber: "205", value: 22.8 },
              { nutrientName: "Fat", nutrientNumber: "204", value: 0.3 },
            ],
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new UsdaNutritionClient("test-only-key");
    await client.resolve(food);
    await client.resolve({ ...food, portionMin: 140, portionMax: 180 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
