/** @vitest-environment node */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/env", () => ({
  getNutritionApiKey: vi.fn(() => null),
}));
vi.mock("@/lib/server/auth", async (original) => ({
  ...await original<typeof import("@/lib/server/auth")>(),
  authenticated: vi.fn(),
}));
vi.mock("@/lib/server/durable-nutrition-quota", () => ({
  reserveHourlyUsdaCall: vi.fn(),
}));

import { getNutritionApiKey } from "@/lib/server/env";
import { authenticated, HttpError } from "@/lib/server/auth";
import { NUTRITION_RATE_LIMIT, clearRateLimitStore } from "@/lib/server/rate-limit";
import { clearUsdaCache } from "@/lib/nutrition/usda";
import { reserveHourlyUsdaCall } from "@/lib/server/durable-nutrition-quota";
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

const remoteNames = [
  "remotealpha", "remotebeta", "remotegamma", "remotedelta",
  "remoteepsilon", "remotezeta", "remoteeta", "remotetheta",
  "remoteiota", "remotekappa", "remotelambda", "remotemu",
];

function remoteFood(name: string) {
  return { ...banana, displayName: name, normalizedName: name, uncertaintyReasons: [] };
}

function usdaResponse(index: number): Response {
  return Response.json({
    foods: [{
      fdcId: 5000 + index,
      description: remoteNames[index],
      foodNutrients: [
        { nutrientNumber: "208", value: 100 + index, unitName: "kcal" },
        { nutrientNumber: "203", value: 10, unitName: "g" },
        { nutrientNumber: "205", value: 12, unitName: "g" },
        { nutrientNumber: "204", value: 3, unitName: "g" },
      ],
    }],
  });
}

function resolveRequest(foods: ReturnType<typeof remoteFood>[], signal?: AbortSignal): Request {
  return new Request("http://localhost/api/nutrition/resolve", {
    method: "POST",
    body: JSON.stringify({ foods }),
    signal,
  });
}

describe("POST /api/nutrition/resolve", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(authenticated).mockResolvedValue({
      db: {} as Awaited<ReturnType<typeof authenticated>>["db"],
      user: { id: "qa-user", email: "qa@example.test" },
    } as Awaited<ReturnType<typeof authenticated>>);
    vi.mocked(reserveHourlyUsdaCall).mockReset().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
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
    expect(reserveHourlyUsdaCall).toHaveBeenCalledTimes(2);
  });

  it("bounds USDA work to three concurrent lookups and restores original match and warning order", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    const pending = new Map<string, (response: Response) => void>();
    let active = 0;
    let peakActive = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const query = new URL(String(input)).searchParams.get("query") ?? "";
      active += 1;
      peakActive = Math.max(peakActive, active);
      const response = await new Promise<Response>((resolve) => pending.set(query, resolve));
      active -= 1;
      return response;
    });
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = POST(resolveRequest(remoteNames.map(remoteFood)));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(active).toBe(3);
    expect(vi.mocked(reserveHourlyUsdaCall)).toHaveBeenCalledTimes(3);

    // Finish some later indexes first. Every freed slot may start one more lookup.
    for (const index of [2, 1, 0, 3, 5, 4, 6, 8, 7, 9, 11, 10]) {
      const name = remoteNames[index];
      await vi.waitFor(() => expect(pending.has(name)).toBe(true));
      pending.get(name)!(index === 1 || index === 8
        ? new Response(null, { status: 429 })
        : usdaResponse(index));
      pending.delete(name);
    }

    const response = await responsePromise;
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(peakActive).toBe(3);
    expect(active).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(12);
    expect(reserveHourlyUsdaCall).toHaveBeenCalledTimes(12);
    expect(body.matches).toHaveLength(12);
    for (const [index, match] of body.matches.entries()) {
      if (index === 1 || index === 8) {
        expect(match.includedInTotal).toBe(false);
      } else {
        expect(match.profile.id).toBe(`usda-${5000 + index}`);
        expect(match.includedInTotal).toBe(true);
      }
    }
    expect(body.warnings).toEqual([
      { index: 1, code: "rate_limited" },
      { index: 8, code: "rate_limited" },
    ]);
  });

  it("does not schedule or reserve later USDA lookups after the request is aborted", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    const pending = new Map<string, (response: Response) => void>();
    const fetchMock = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
      const query = new URL(String(input)).searchParams.get("query") ?? "";
      return new Promise<Response>((resolve) => pending.set(query, resolve));
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const responsePromise = POST(resolveRequest(remoteNames.map(remoteFood), controller.signal));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(reserveHourlyUsdaCall).toHaveBeenCalledTimes(3);
    controller.abort();
    for (const index of [2, 0, 1]) {
      pending.get(remoteNames[index])!(usdaResponse(index));
    }

    const response = await responsePromise;
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.matches).toHaveLength(12);
    for (const match of body.matches.slice(3)) {
      expect(match.includedInTotal).toBe(false);
      expect(match.profile).toBeNull();
    }
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(reserveHourlyUsdaCall).toHaveBeenCalledTimes(3);
  });

  it("keeps a shared pending USDA lookup usable when one caller aborts", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    let finishFetch: (response: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finishFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const food = remoteFood(remoteNames[0]);
    const first = POST(resolveRequest([food], controller.signal));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const second = POST(resolveRequest([food]));
    await vi.waitFor(() => expect(authenticated).toHaveBeenCalledTimes(2));

    controller.abort();
    finishFetch(usdaResponse(0));
    const [firstResponse, secondResponse] = await Promise.all([first, second]);
    const secondBody = await secondResponse.json();
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    expect(secondBody.matches[0].profile.id).toBe("usda-5000");
    expect(secondBody.matches[0].includedInTotal).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(reserveHourlyUsdaCall).toHaveBeenCalledOnce();
  });

  it.each([
    [{ allowed: false, retryAfterSeconds: 30 }, "rate_limited"],
    [new Error("quota storage unavailable"), "unavailable"],
  ])("preserves unresolved food without USDA fetch when durable budget is %s", async (admission, code) => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    if (admission instanceof Error)
      vi.mocked(reserveHourlyUsdaCall).mockRejectedValue(admission);
    else
      vi.mocked(reserveHourlyUsdaCall).mockResolvedValue(admission);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(new Request("http://localhost/api/nutrition/resolve", {
      method: "POST",
      body: JSON.stringify({ foods: [{ ...banana, displayName: "scallops", normalizedName: "scallops" }] }),
    }));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.matches[0].includedInTotal).toBe(false);
    expect(body.warnings).toEqual([{ index: 0, code }]);
    expect(authenticated).toHaveBeenCalledOnce();
    expect(reserveHourlyUsdaCall).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
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

  it.each([undefined, "8"])(
    "cancels oversized JSON without parsing or USDA calls with content-length %s",
    async (contentLength) => {
      vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const cancel = vi.fn();
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(pulls === 1 ? 1 : 150_000));
        },
        cancel,
      }, { highWaterMark: 0 });
      const headers = new Headers({ "content-type": "application/json" });
      if (contentLength !== undefined) headers.set("content-length", contentLength);
      const request = new Request("http://localhost/api/nutrition/resolve", {
        method: "POST", headers, body: stream, duplex: "half",
      } as RequestInit);
      const parse = vi.spyOn(JSON, "parse");
      const response = await POST(request);

      expect(parse).not.toHaveBeenCalled();
      parse.mockRestore();
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({ error: { code: "invalid_request" } });
      expect(cancel).toHaveBeenCalledOnce();
      expect(pulls).toBe(2);
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("accepts valid nutrition JSON exactly at the byte cap", async () => {
    const text = JSON.stringify({ foods: [banana] });
    const body = text + " ".repeat(150_000 - new TextEncoder().encode(text).length);
    const response = await POST(new Request("http://localhost/api/nutrition/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }));

    expect(response.status).toBe(200);
    expect((await response.json()).matches[0].includedInTotal).toBe(true);
  });

  it("returns a controlled error for malformed JSON", async () => {
    const response = await POST(new Request("http://localhost/api/nutrition/resolve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"private-input":',
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request" } });
  });

  it("returns a controlled error for an interrupted input stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error("private transport details")); },
    });
    const response = await POST(new Request("http://localhost/api/nutrition/resolve", {
      method: "POST", body: stream, duplex: "half",
    } as RequestInit));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request" } });
  });
});
