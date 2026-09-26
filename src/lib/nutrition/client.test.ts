/** @vitest-environment node */

import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalizeFood } from "./canonical";
import {
  canReuseNutritionMatchForNameEdit,
  enrichUnresolvedMatches,
} from "./client";
import type { NutritionMatch } from "./types";
import { calculateFoodNutrition } from "./calculation";

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
      gramsPerUnit: { g: 1 },
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

  it.each(["http", "network", "malformed"])("explains a %s lookup failure without dropping resolved foods or retrying", async (failure) => {
    const localMatches = [cachedUsdaMatch(), { ...cachedUsdaMatch(), profile: null, includedInTotal: false }];
    const fetchMock = vi.fn();
    if (failure === "network") fetchMock.mockRejectedValue(new TypeError("Network failed"));
    else fetchMock.mockResolvedValue({ ok: failure !== "http", json: async () => ({}) });
    vi.stubGlobal("fetch", fetchMock);

    const matches = await enrichUnresolvedMatches([scallops, scallops], localMatches);
    expect(matches[0]).toBe(localMatches[0]);
    expect(matches[1].includedInTotal).toBe(false);
    expect(matches[1].reasons[0]).toContain("補充營養資料暫時未能取得");
    expect(localMatches[1].reasons).toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("maps provider warnings to only their unresolved food while retaining earlier successes", async () => {
    const localMatches = [cachedUsdaMatch(), { ...cachedUsdaMatch(), profile: null, includedInTotal: false }, { ...cachedUsdaMatch(), profile: null, includedInTotal: false }];
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ matches: [cachedUsdaMatch(), localMatches[2]], warnings: [{ index: 1, code: "rate_limited" }] }),
    }));
    const matches = await enrichUnresolvedMatches([scallops, scallops, scallops], localMatches);
    expect(matches[0]).toBe(localMatches[0]);
    expect(matches[1]).toEqual(cachedUsdaMatch());
    expect(matches[2].includedInTotal).toBe(false);
    expect(matches[2].reasons[0]).toContain("補充營養資料暫時未能取得");
  });

  it("keeps a successful unsupported-food result distinct from service failure", async () => {
    const unresolved = { ...cachedUsdaMatch(), profile: null, includedInTotal: false, reasons: ["未有可靠的整道菜資料。"] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ matches: [unresolved] }) }));
    expect(await enrichUnresolvedMatches([scallops], [unresolved])).toEqual([unresolved]);
  });

  it("does not label a cancelled lookup as a service failure", async () => {
    const controller = new AbortController();
    const unresolved = { ...cachedUsdaMatch(), profile: null, includedInTotal: false };
    vi.stubGlobal("fetch", vi.fn(async () => {
      controller.abort();
      throw new DOMException("Cancelled", "AbortError");
    }));
    expect(await enrichUnresolvedMatches([scallops], [unresolved], controller.signal)).toEqual([unresolved]);
  });

  it.each([
    { includedInTotal: true },
    { ...cachedUsdaMatch(), reasons: null },
    { ...cachedUsdaMatch(), identity: null },
    { ...cachedUsdaMatch(), profile: null },
    { ...cachedUsdaMatch(), profile: { ...cachedUsdaMatch().profile, gramsPerUnit: null } },
    { ...cachedUsdaMatch(), profile: { ...cachedUsdaMatch().profile, nutrientsPer100g: { calories: { min: -1, max: 5 } } } },
    { ...cachedUsdaMatch(), confidence: "low" },
  ])("rejects a malformed successful match without breaking calculation", async (badMatch) => {
    const unresolved = { ...cachedUsdaMatch(), profile: null, includedInTotal: false };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ matches: [cachedUsdaMatch(), badMatch] }),
    }));
    const matches = await enrichUnresolvedMatches([scallops, scallops], [unresolved, unresolved]);
    expect(matches[0]).toEqual(cachedUsdaMatch());
    expect(matches[1].includedInTotal).toBe(false);
    expect(matches[1].reasons[0]).toContain("補充營養資料暫時未能取得");
    expect(calculateFoodNutrition(scallops, matches[1]).ranges).toBeNull();
  });
});
