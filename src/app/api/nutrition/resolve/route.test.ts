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
import { PHOTO_GENERIC_MILK_CONFIRMATION_REASON, PLANT_MILK_CONTRADICTION_REASON } from "@/lib/nutrition/negative-rules";
import { oatMilkCartonPhotoAnalysis } from "@/lib/nutrition/oat-milk-photo.fixture";
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
  return { ...banana, displayName: name, normalizedName: name, uncertaintyReasons: [] as string[] };
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
    vi.useRealTimers();
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

  it("returns completed USDA matches at the batch deadline and does not schedule later foods", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = new Map<string, (response: Response) => void>();
    const fetchMock = vi.fn((input: RequestInfo | URL) => new Promise<Response>((resolve) => {
      const query = new URL(String(input)).searchParams.get("query") ?? "";
      pending.set(query, resolve);
    }));
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = POST(resolveRequest(remoteNames.map(remoteFood)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    pending.get(remoteNames[0])!(usdaResponse(0));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledTimes(4);

    await vi.advanceTimersByTimeAsync(12_000);
    const response = await responsePromise;
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.matches[0].profile.id).toBe("usda-5000");
    expect(body.matches[0].includedInTotal).toBe(true);
    expect(body.matches.slice(1).every((match: { includedInTotal: boolean }) => !match.includedInTotal)).toBe(true);
    expect(body.warnings).toEqual(remoteNames.slice(1).map((_, offset) => ({
      index: offset + 1, code: "timeout",
    })));
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(reserveHourlyUsdaCall).toHaveBeenCalledTimes(4);
  });

  it("returns at the batch deadline even when durable quota reservation has not settled", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const finishReservations: Array<(value: { allowed: boolean; retryAfterSeconds: number }) => void> = [];
    vi.mocked(reserveHourlyUsdaCall).mockImplementation(() => new Promise((resolve) => {
      finishReservations.push(resolve);
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = POST(resolveRequest(remoteNames.map(remoteFood)));
    await new Promise((resolve) => setImmediate(resolve));
    expect(finishReservations).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(12_000);
    const response = await responsePromise;
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.matches.every((match: { includedInTotal: boolean }) => !match.includedInTotal)).toBe(true);
    expect(body.warnings).toEqual(remoteNames.map((_, index) => ({ index, code: "timeout" })));
    expect(reserveHourlyUsdaCall).toHaveBeenCalledTimes(3);
    expect(fetchMock).not.toHaveBeenCalled();

    for (const finish of finishReservations) finish({ allowed: true, retryAfterSeconds: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds USDA enrichment while authentication is pending", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    vi.mocked(authenticated).mockImplementationOnce(() => new Promise(() => {}));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const responsePromise = POST(resolveRequest([remoteFood(remoteNames[0])]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(authenticated).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(12_000);
    const response = await responsePromise;
    expect(response.status).toBe(200);
    expect((await response.json()).warnings).toEqual([{ index: 0, code: "timeout" }]);
    expect(reserveHourlyUsdaCall).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps a shared USDA lookup running for a later caller after the first batch deadline", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let finishFetch: (response: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finishFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const food = remoteFood(remoteNames[0]);

    const first = POST(resolveRequest([food]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchMock).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(6_000);
    const second = POST(resolveRequest([food]));
    await new Promise((resolve) => setImmediate(resolve));
    expect(authenticated).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(6_000);
    const firstResponse = await first;
    expect((await firstResponse.json()).warnings).toEqual([{ index: 0, code: "timeout" }]);
    expect(fetchMock).toHaveBeenCalledOnce();
    finishFetch(usdaResponse(0));
    const secondResponse = await second;
    const secondBody = await secondResponse.json();
    expect(secondResponse.status).toBe(200);
    expect(secondBody.matches[0].profile.id).toBe("usda-5000");
    expect(secondBody.warnings).toBeUndefined();
    expect(reserveHourlyUsdaCall).toHaveBeenCalledOnce();
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
    const firstBody = await firstResponse.json();
    const secondBody = await secondResponse.json();
    expect(firstResponse.status).toBe(200);
    expect(firstBody.matches[0].includedInTotal).toBe(false);
    expect(firstBody.warnings).toEqual([{ index: 0, code: "canceled" }]);
    expect(secondResponse.status).toBe(200);
    expect(secondBody.matches[0].profile.id).toBe("usda-5000");
    expect(secondBody.matches[0].includedInTotal).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(reserveHourlyUsdaCall).toHaveBeenCalledOnce();
  });

  it("does not fetch USDA after the request aborts during quota reservation", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    let finishReservation!: (value: { allowed: boolean; retryAfterSeconds: number }) => void;
    vi.mocked(reserveHourlyUsdaCall).mockImplementationOnce(() => new Promise((resolve) => {
      finishReservation = resolve;
    }));
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const responsePromise = POST(resolveRequest([remoteFood(remoteNames[0])], controller.signal));
    await vi.waitFor(() => expect(reserveHourlyUsdaCall).toHaveBeenCalledOnce());

    controller.abort();
    const response = await responsePromise;
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.matches[0].includedInTotal).toBe(false);
    expect(body.warnings).toEqual([{ index: 0, code: "canceled" }]);
    finishReservation({ allowed: true, retryAfterSeconds: 0 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchMock).not.toHaveBeenCalled();
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

  it.each(["ml", "piece", "bowl", "cup"] as const)(
    "keeps an unknown %s portion unresolved without remote authorization or cost",
    async (unit) => {
      vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
      vi.mocked(authenticated).mockRejectedValue(new HttpError(401, "login_required"));
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const response = await POST(resolveRequest([{
        ...remoteFood("unrecognizedfood"), unit,
      }]));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.matches).toHaveLength(1);
      expect(body.matches[0].profile).toBeNull();
      expect(body.matches[0].includedInTotal).toBe(false);
      expect(body.warnings).toBeUndefined();
      expect(authenticated).not.toHaveBeenCalled();
      expect(reserveHourlyUsdaCall).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

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

  it("skips USDA live lookup for a contradictory dairy label and still looks up other foods", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({ foods: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const guarded = [
      { ...remoteFood("牛奶"), displayName: "牛奶", normalizedName: "whole milk", notes: "oat milk" },
      { ...remoteFood("鮮奶"), displayName: "鮮奶", normalizedName: "fresh milk", notes: "燕麥" },
      { ...remoteFood("低脂奶"), displayName: "低脂奶", normalizedName: "low-fat milk", visibleIngredients: ["soy milk"] },
      { ...remoteFood("脫脂奶"), displayName: "脫脂奶", normalizedName: "skim milk", uncertaintyReasons: ["杏仁奶"] },
    ];
    const response = await POST(resolveRequest([...guarded, remoteFood("mystery food")]));
    const body = await response.json();
    const queries = fetchMock.mock.calls.map((call) =>
      new URL(String(call[0])).searchParams.get("query") ?? "");

    expect(response.status).toBe(200);
    expect(queries).toEqual(["mystery food"]);
    expect(reserveHourlyUsdaCall).toHaveBeenCalledTimes(1);
    for (const [index, food] of guarded.entries()) {
      expect(body.matches[index].includedInTotal, food.displayName).toBe(false);
      expect(body.matches[index].reasons[0], food.displayName).toBe(PLANT_MILK_CONTRADICTION_REASON);
    }
    expect(body.matches[4].includedInTotal).toBe(false);
  });

  it("does not send 熱牛奶 with an oat-milk note to USDA live", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({ foods: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const hotMilk = {
      ...remoteFood("熱牛奶"),
      displayName: "熱牛奶",
      normalizedName: "hot milk",
      notes: "燕麥奶",
    };
    const response = await POST(resolveRequest([hotMilk, remoteFood("mystery food")]));
    const body = await response.json();
    const queries = fetchMock.mock.calls.map((call) =>
      new URL(String(call[0])).searchParams.get("query") ?? "");

    expect(response.status).toBe(200);
    expect(queries).toEqual(["mystery food"]);
    expect(reserveHourlyUsdaCall).toHaveBeenCalledOnce();
    expect(body.matches[0].includedInTotal).toBe(false);
    expect(body.matches[0].reasons[0]).toBe(PLANT_MILK_CONTRADICTION_REASON);
    expect(body.matches[1].includedInTotal).toBe(false);
  });

  it("does not send photo-labelled 牛奶 to USDA when the meal saw oat milk", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({ foods: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const drink = oatMilkCartonPhotoAnalysis.foods[0];
    const response = await POST(new Request("http://localhost/api/nutrition/resolve", {
      method: "POST",
      body: JSON.stringify({
        mealContext: {
          visibleEvidence: oatMilkCartonPhotoAnalysis.visibleEvidence,
          uncertaintyText: [
            ...oatMilkCartonPhotoAnalysis.uncertaintyReasons,
            ...oatMilkCartonPhotoAnalysis.estimatedInformation,
            ...oatMilkCartonPhotoAnalysis.unknownInformation,
          ],
        },
        foods: [drink, remoteFood("mystery food")],
      }),
    }));
    const body = await response.json();
    const queries = fetchMock.mock.calls.map((call) =>
      new URL(String(call[0])).searchParams.get("query") ?? "");

    expect(response.status).toBe(200);
    expect(queries).toEqual(["mystery food"]);
    expect(body.matches[0].profile).toBeNull();
    expect(body.matches[0].includedInTotal).toBe(false);
    expect(body.matches[0].reasons[0]).toBe(PLANT_MILK_CONTRADICTION_REASON);
  });

  it("resolves 鮮奶 locally and still looks up low-fat milk", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({ foods: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(resolveRequest([
      { ...remoteFood("鮮奶"), displayName: "鮮奶", normalizedName: "fresh milk" },
      { ...remoteFood("低脂奶"), displayName: "低脂奶", normalizedName: "低脂奶" },
    ]));
    const body = await response.json();
    const queries = fetchMock.mock.calls.map((call) =>
      new URL(String(call[0])).searchParams.get("query") ?? "");

    expect(response.status).toBe(200);
    expect(queries).toEqual(["低脂奶"]);
    expect(reserveHourlyUsdaCall).toHaveBeenCalledOnce();
    expect(body.matches[0].profile.id).toBe("whole-milk");
    expect(body.matches[0].includedInTotal).toBe(true);
    expect(body.matches[1].includedInTotal).toBe(false);
    expect(body.matches[1].profile).toBeNull();
  });

  it("resolves 鮮奶 locally when no USDA key is configured", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await POST(resolveRequest([
      { ...remoteFood("鮮奶"), displayName: "鮮奶", normalizedName: "鮮奶" },
    ]));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.provider).toBe("kcalcue-reference");
    expect(body.matches[0].profile.id).toBe("whole-milk");
    expect(body.matches[0].includedInTotal).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reserveHourlyUsdaCall).not.toHaveBeenCalled();
  });

  it("does not look up USDA for a photo labelled only 牛奶", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    const fetchMock = vi.fn(async () => Response.json({ foods: [] }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await POST(new Request("http://localhost/api/nutrition/resolve", {
      method: "POST",
      body: JSON.stringify({
        foods: [{
          ...remoteFood("牛奶"),
          displayName: "牛奶",
          normalizedName: "milk",
          unit: "ml",
          entrySource: "photo",
        }],
      }),
    }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(body.matches[0].includedInTotal).toBe(false);
    expect(body.matches[0].reasons[0]).toBe(PHOTO_GENERIC_MILK_CONFIRMATION_REASON);
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
