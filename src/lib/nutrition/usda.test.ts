import { afterEach, describe, expect, it, vi } from "vitest";

import { clearUsdaCache, UsdaNutritionClient, UsdaNutritionError } from "./usda";
import { canonicalizeFood } from "./canonical";

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
    vi.restoreAllMocks();
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
    expect(match.profile?.gramsPerUnit).toEqual({ g: 1 });
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

  it.each(["ml", "piece", "bowl", "cup"] as const)(
    "does not include %s when USDA has no gram factor",
    async (unit) => {
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
                  { nutrientName: "Carbohydrate", nutrientNumber: "205", value: 22.8, unitName: "g" },
                  { nutrientName: "Total lipid (fat)", nutrientNumber: "204", value: 0.3, unitName: "g" },
                ],
              },
            ],
          }),
        }),
      );

      const match = await new UsdaNutritionClient("test-only-key").resolve({
        ...food,
        unit,
      });

      expect(match.profile?.gramsPerUnit).toEqual({ g: 1 });
      expect(match.includedInTotal).toBe(false);
      expect(match.reasons.at(-1)).toContain(unit);
    },
  );

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

  it("shares one in-flight USDA request between concurrent identical lookups", async () => {
    let finishFetch!: (value: unknown) => void;
    const fetchMock = vi.fn(() => new Promise((resolve) => { finishFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const reserve = vi.fn().mockResolvedValue(true);
    const client = new UsdaNutritionClient("test-only-key", reserve);
    const first = client.resolve(food);
    const second = client.resolve({ ...food, portionMin: 200, portionMax: 220 });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    expect(reserve).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
    finishFetch({ ok: true, status: 200, json: async () => ({ foods: [] }) });
    const results = await Promise.all([first, second]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].matchType).toBe("unresolved");
    await client.resolve(food);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(reserve).toHaveBeenCalledOnce();
  });

  it.each([
    [false, "rate_limited"],
    [new Error("quota storage unavailable"), "unavailable"],
  ])("does not contact USDA when durable budget returns %s", async (admission, code) => {
    const reserve = admission instanceof Error
      ? vi.fn().mockRejectedValue(admission)
      : vi.fn().mockResolvedValue(admission);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(new UsdaNutritionClient("test-only-key", reserve).resolve(food))
      .rejects.toMatchObject({ code });
    expect(reserve).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("retries USDA after a failed in-flight lookup", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException("Timed out", "TimeoutError"))
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ foods: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    const client = new UsdaNutritionClient("test-only-key");
    await expect(client.resolve(food)).rejects.toMatchObject({ code: "timeout" });
    expect((await client.resolve(food)).matchType).toBe("unresolved");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not let an old request refill or clear the cache after reset", async () => {
    let finishOld!: (value: unknown) => void;
    let finishNew!: (value: unknown) => void;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new UsdaNutritionClient("test-only-key");
    const oldRequest = client.resolve(food);
    clearUsdaCache();
    const newRequest = client.resolve(food);
    finishOld({ ok: true, status: 200, json: async () => ({ foods: [{
      fdcId: 1105314,
      description: "Banana, raw",
      foodNutrients: [
        { nutrientName: "Energy", nutrientNumber: "208", value: 89, unitName: "kcal" },
        { nutrientName: "Protein", nutrientNumber: "203", value: 1.1, unitName: "g" },
        { nutrientName: "Carbohydrate", nutrientNumber: "205", value: 22.8, unitName: "g" },
        { nutrientName: "Fat", nutrientNumber: "204", value: 0.3, unitName: "g" },
      ],
    }] }) });
    expect((await oldRequest).profile?.source.sourceId).toBe("1105314");
    const joinedNewRequest = client.resolve(food);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    finishNew({ ok: true, status: 200, json: async () => ({ foods: [] }) });
    expect((await Promise.all([newRequest, joinedNewRequest])).map((match) => match.matchType))
      .toEqual(["unresolved", "unresolved"]);
    expect((await client.resolve(food)).matchType).toBe("unresolved");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("expires old USDA matches and evicts the oldest of 257 distinct foods", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ foods: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new UsdaNutritionClient("test-only-key");
    await client.resolve(food);
    await client.resolve(food);
    expect(fetchMock).toHaveBeenCalledOnce();
    now += 60 * 60 * 1_000;
    await client.resolve(food);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    for (let index = 0; index < 256; index += 1) {
      await client.resolve({ ...food, displayName: `food ${index}`, normalizedName: `food ${index}` });
    }
    await client.resolve(food);
    expect(fetchMock).toHaveBeenCalledTimes(259);
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

  it("does not share a cache entry when the actual USDA query changes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ foods: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new UsdaNutritionClient("test-only-key");
    const other = { ...food, displayName: "yellow banana" };
    expect(canonicalizeFood(other)).toEqual(canonicalizeFood(food));
    await client.resolve(food);
    await client.resolve(other);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const queries = fetchMock.mock.calls.map(([url]) => new URL(String(url)).searchParams.get("query"));
    expect(queries).toEqual(["banana", "banana yellow banana"]);
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
