/** @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/env", () => ({
  getNutritionApiKey: vi.fn(() => null),
}));

import { getNutritionApiKey } from "@/lib/server/env";
import { POST } from "./route";

const banana = {
  displayName: "香蕉",
  normalizedName: "banana",
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
  });

  afterEach(() => {
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
});
