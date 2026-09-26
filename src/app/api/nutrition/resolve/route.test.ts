/** @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/env", () => ({
  getNutritionApiKey: vi.fn(() => null),
}));
vi.mock("@/lib/server/auth", async (original) => ({
  ...await original<typeof import("@/lib/server/auth")>(),
  authenticated: vi.fn(),
}));

import { getNutritionApiKey } from "@/lib/server/env";
import { authenticated, HttpError } from "@/lib/server/auth";
import { NUTRITION_RATE_LIMIT, clearRateLimitStore } from "@/lib/server/rate-limit";
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
    vi.clearAllMocks();
    vi.mocked(authenticated).mockResolvedValue({} as Awaited<ReturnType<typeof authenticated>>);
    vi.mocked(getNutritionApiKey).mockReturnValue(null);
    clearRateLimitStore();
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
    expect(authenticated).toHaveBeenCalledOnce();
  });

  it.each([
    [401, "login_required"],
    [403, "trial_access_required"],
    [403, "email_unverified"],
    [503, "cloud_unavailable"],
  ] as const)("denies external lookup with %s %s before contacting the provider", async (status, code) => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    vi.mocked(authenticated).mockRejectedValue(new HttpError(status, code));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(new Request("http://localhost/api/nutrition/resolve", {
      method: "POST",
      body: JSON.stringify({ foods: [{ ...banana, displayName: "scallops", normalizedName: "scallops" }] }),
    }));
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: { code } });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(authenticated).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["local", "composite", "no-key"])("keeps %s resolution available without remote authorization", async (mode) => {
    vi.mocked(getNutritionApiKey).mockReturnValue(mode === "no-key" ? null : "test-only-key");
    vi.mocked(authenticated).mockRejectedValue(new HttpError(401, "login_required"));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const food = mode === "local" ? banana : { ...banana, displayName: "unrecognized food", normalizedName: "unrecognized food", identityLevel: mode === "composite" ? "dish" : "ingredient" };
    const response = await POST(new Request("http://localhost/api/nutrition/resolve", {
      method: "POST",
      body: JSON.stringify({ foods: [food] }),
    }));
    expect(response.status).toBe(200);
    expect(authenticated).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns 429 after the nutrition rate limit is exceeded", async () => {
    const headers = {
      "Content-Type": "application/json",
      "x-forwarded-for": "198.51.100.9",
    };

    for (let index = 0; index < NUTRITION_RATE_LIMIT.limit; index += 1) {
      const allowed = await POST(
        new Request("http://localhost/api/nutrition/resolve", {
          method: "POST",
          headers,
          body: JSON.stringify({ foods: [banana] }),
        }),
      );
      expect(allowed.status).toBe(200);
    }

    const blocked = await POST(
      new Request("http://localhost/api/nutrition/resolve", {
        method: "POST",
        headers,
        body: JSON.stringify({ foods: [banana] }),
      }),
    );
    const body = await blocked.json();

    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
    expect(body).toEqual({ error: { code: "rate_limited" } });
  });
});
