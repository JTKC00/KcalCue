/** @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/env", () => ({
  getNutritionApiKey: vi.fn(() => null),
}));

import { getNutritionApiKey } from "@/lib/server/env";
import { clearUsdaCache } from "@/lib/nutrition/usda";
import { POST } from "./route";

const banana = {
  displayName: "香蕉",
  normalizedName: "banana",
  identityLevel: "ingredient" as const,
  portionMin: 100,
  portionMax: 120,
  unit: "g",
  recognitionConfidence: 0.9,
  portionConfidence: 0.8,
  uncertaintyReasons: ["顏色只能估計熟度。"],
};

describe("POST /api/nutrition/resolve", () => {
  beforeEach(() => {
    vi.mocked(getNutritionApiKey).mockReturnValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    clearUsdaCache();
    vi.restoreAllMocks();
  });

  it("resolves locally when no nutrition API key is configured", async () => {
    const response = await POST(
      new Request("http://localhost/api/nutrition/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ foods: [banana] }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.provider).toBe("kcalcue-reference");
    expect(body.matches[0].profile.id).toBe("banana");
    expect(body.matches[0].includedInTotal).toBe(true);
  });

  it("still starts and returns a public error for invalid payloads", async () => {
    const response = await POST(
      new Request("http://localhost/api/nutrition/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ foods: "nope" }),
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(400);
    expect(body).toEqual({ error: { code: "invalid_request" } });
  });

  it("keeps earlier USDA matches when a later food is rate-limited", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          foods: [
            {
              fdcId: 2101,
              description: "Scallop, raw",
              foodNutrients: [
                { nutrientName: "Energy", nutrientNumber: "208", value: 69, unitName: "kcal" },
                { nutrientName: "Protein", nutrientNumber: "203", value: 12.1, unitName: "g" },
                { nutrientName: "Carbohydrate, by difference", nutrientNumber: "205", value: 3.2, unitName: "g" },
                { nutrientName: "Total lipid (fat)", nutrientNumber: "204", value: 0.5, unitName: "g" },
              ],
            },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 429 });
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(
      new Request("http://localhost/api/nutrition/resolve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          foods: [
            {
              displayName: "scallops",
              normalizedName: "scallops",
              identityLevel: "ingredient",
              portionMin: 100,
              portionMax: 120,
              unit: "g",
              recognitionConfidence: 0.8,
              portionConfidence: 0.7,
              uncertaintyReasons: [],
            },
            {
              displayName: "mystery food",
              normalizedName: "mystery food",
              identityLevel: "ingredient",
              portionMin: 50,
              portionMax: 80,
              unit: "g",
              recognitionConfidence: 0.4,
              portionConfidence: 0.5,
              uncertaintyReasons: ["名稱仍然不確定。"],
            },
          ],
        }),
      }),
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.matches).toHaveLength(2);
    expect(body.matches[0].profile.source.provider).toBe("usda-fdc");
    expect(body.matches[0].includedInTotal).toBe(true);
    expect(body.matches[1].includedInTotal).toBe(false);
    expect(body.warnings).toEqual([{ index: 1, code: "rate_limited" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
