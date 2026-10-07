import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authorize = vi.fn();
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  authenticated: (...args: unknown[]) => authorize(...args),
}));
vi.mock("@/lib/firebase/meals", async (original) => ({
  ...(await original<typeof import("@/lib/firebase/meals")>()),
  previousMeal: vi.fn(),
  commitMeal: vi.fn(),
  listMeals: vi.fn(),
  listMealPage: vi.fn(),
}));
vi.mock("@/lib/server/env", () => ({ getNutritionApiKey: vi.fn(() => null) }));
vi.mock("@/lib/server/durable-nutrition-quota", () => ({ reserveHourlyUsdaCall: vi.fn() }));
vi.mock("@/lib/server/meal-lookup-attempt", () => ({
  claimMealLookupAttempt: vi.fn(), releaseMealLookupAttempt: vi.fn(),
}));

import { commitMeal, listMealPage, listMeals, previousMeal } from "@/lib/firebase/meals";
import { getNutritionApiKey } from "@/lib/server/env";
import { reserveHourlyUsdaCall } from "@/lib/server/durable-nutrition-quota";
import { claimMealLookupAttempt, releaseMealLookupAttempt } from "@/lib/server/meal-lookup-attempt";
import { copy } from "@/content/zh-HK";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import type { NutritionMatch } from "@/lib/nutrition/types";
import { CURRENT_MEAL_SCHEMA_VERSION, type MealRecord } from "@/lib/meals/types";
import { HttpError } from "@/lib/server/auth";
import { GET, POST } from "./route";

const meal = {
  id: "11111111-1111-4111-8111-111111111111",
  mutationId: "22222222-2222-4222-8222-222222222222",
  version: 0,
  date: "2026-09-26",
  time: "12:00",
  timezone: "Asia/Hong_Kong",
  mealType: "lunch",
  mode: "manual",
  analysis: null,
  photoPath: null,
  items: [{
    id: "banana",
    displayName: "香蕉",
    normalizedName: "banana",
    identityLevel: "ingredient",
    portionMin: 100,
    portionMax: 120,
    originalPortionMin: 100,
    originalPortionMax: 120,
    unit: "g",
    recognitionConfidence: 0.9,
    portionConfidence: 0.8,
    uncertaintyReasons: [],
  }],
};

function jsonRequest(body: string) {
  return new Request("http://localhost/api/meals", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
}

describe("GET /api/meals revision reads", () => {
  beforeEach(() => {
    authorize.mockReset();
    vi.mocked(listMeals).mockReset().mockResolvedValue([meal as unknown as MealRecord]);
    vi.mocked(listMealPage).mockReset().mockResolvedValue({ records: [meal as unknown as MealRecord] });
  });

  it("returns existing meals when the account revision document is absent", async () => {
    const get = vi.fn().mockResolvedValue({ data: () => undefined });
    authorize.mockResolvedValue({ db: { doc: () => ({ get }) }, user: { id: "qa-user" } });

    const response = await GET(new Request("http://localhost/api/meals?since=empty"));

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ records: [meal], revision: "empty" });
    expect(listMeals).toHaveBeenCalledOnce();
  });

  it("keeps the unchanged-revision shortcut when a revision exists", async () => {
    const get = vi.fn().mockResolvedValue({ data: () => ({ revision: "rev-1" }) });
    authorize.mockResolvedValue({ db: { doc: () => ({ get }) }, user: { id: "qa-user" } });

    const response = await GET(new Request("http://localhost/api/meals?since=rev-1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: "rev-1" });
    expect(listMeals).not.toHaveBeenCalled();
  });

  it("rejects a legacy full read if its revision changes during the query", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ data: () => ({ revision: "rev-1" }) })
      .mockResolvedValueOnce({ data: () => ({ revision: "rev-2" }) });
    authorize.mockResolvedValue({ db: { doc: () => ({ get }) }, user: { id: "qa-user" } });
    const response = await GET(new Request("http://localhost/api/meals"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "snapshot_changed" } });
    expect(listMeals).toHaveBeenCalledOnce();
  });

  it("checks the account revision around a bounded page", async () => {
    const get = vi.fn().mockResolvedValue({ data: () => ({ revision: "rev-1" }) });
    authorize.mockResolvedValue({ db: { doc: () => ({ get }) }, user: { id: "qa-user" } });
    vi.mocked(listMealPage).mockResolvedValue({ records: [meal as unknown as MealRecord], nextCursor: meal.id });

    const response = await GET(new Request("http://localhost/api/meals?paged=1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ records: [meal], revision: "rev-1", nextCursor: meal.id });
    expect(get).toHaveBeenCalledTimes(2);
    expect(listMealPage).toHaveBeenCalledWith(expect.anything(), "qa-user", undefined);
    expect(listMeals).not.toHaveBeenCalled();
  });

  it.each([
    "?paged=1&cursor=bad&revision=rev-1",
    `?paged=1&cursor=${meal.id}`,
    "?paged=1&revision=rev-1",
  ])("rejects an invalid paged cursor request: %s", async (query) => {
    authorize.mockResolvedValue({ db: {}, user: { id: "qa-user" } });
    const response = await GET(new Request(`http://localhost/api/meals${query}`));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request" } });
    expect(listMealPage).not.toHaveBeenCalled();
  });

  it("rejects a revision change before a continuation read", async () => {
    const get = vi.fn().mockResolvedValue({ data: () => ({ revision: "rev-2" }) });
    authorize.mockResolvedValue({ db: { doc: () => ({ get }) }, user: { id: "qa-user" } });
    const response = await GET(new Request(`http://localhost/api/meals?paged=1&cursor=${meal.id}&revision=rev-1`));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "snapshot_changed" } });
    expect(listMealPage).not.toHaveBeenCalled();
  });

  it("rejects a revision change during the page query", async () => {
    const get = vi.fn()
      .mockResolvedValueOnce({ data: () => ({ revision: "rev-1" }) })
      .mockResolvedValueOnce({ data: () => ({ revision: "rev-2" }) });
    authorize.mockResolvedValue({ db: { doc: () => ({ get }) }, user: { id: "qa-user" } });
    const response = await GET(new Request("http://localhost/api/meals?paged=1"));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: { code: "snapshot_changed" } });
  });

  it("reads a paged collection when the revision is empty even if since matches", async () => {
    const get = vi.fn().mockResolvedValue({ data: () => undefined });
    authorize.mockResolvedValue({ db: { doc: () => ({ get }) }, user: { id: "qa-user" } });
    const response = await GET(new Request("http://localhost/api/meals?paged=1&since=empty"));
    expect(await response.json()).toEqual({ records: [meal], revision: "empty" });
    expect(listMeals).toHaveBeenCalledOnce();
    expect(listMealPage).not.toHaveBeenCalled();
  });
});

describe("POST /api/meals bounded input", () => {
  beforeEach(() => {
    authorize.mockReset().mockResolvedValue({ db: {}, user: { id: "qa-user" } });
    vi.mocked(getNutritionApiKey).mockReset().mockReturnValue(null);
    vi.mocked(reserveHourlyUsdaCall).mockReset().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
    vi.mocked(claimMealLookupAttempt).mockReset().mockResolvedValue({ state: "claimed", token: "test-token" });
    vi.mocked(releaseMealLookupAttempt).mockReset().mockResolvedValue(true);
    vi.mocked(previousMeal).mockReset().mockResolvedValue(undefined);
    vi.mocked(commitMeal).mockReset().mockImplementation(async (_db, _userId, record) => ({
      ...record,
      updatedAt: "2026-09-26T00:00:00.000Z",
    }));
  });

  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

  it("persists a valid meal with the existing ownership and version behavior", async () => {
    const response = await POST(jsonRequest(JSON.stringify(meal)));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.record).toMatchObject({
      id: meal.id, userId: "qa-user", version: 1, mutationId: meal.mutationId,
    });
    expect(commitMeal).toHaveBeenCalledOnce();
    expect(body.record.items[0].nutritionMatch.includedInTotal).toBe(true);
  });

  it("recomputes a saved USDA gram match after a unit edit without another provider call", async () => {
    const localMatch = new LocalNutritionProvider().resolve({
      ...meal.items[0], identityLevel: "ingredient", unit: "g",
    });
    const oldMatch: NutritionMatch = {
      ...localMatch,
      profile: {
        ...localMatch.profile!, id: "usda-test", gramsPerUnit: { g: 1 },
        source: { ...localMatch.profile!.source, provider: "usda-fdc" },
      },
    };
    expect(oldMatch.includedInTotal).toBe(true);
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.mocked(previousMeal).mockResolvedValue({
      deleted: false, version: 1,
      mutationId: "33333333-3333-4333-8333-333333333333",
      record: { ...meal, mutationId: "33333333-3333-4333-8333-333333333333",
        version: 1, items: [{ ...meal.items[0], nutritionMatch: oldMatch }] } as unknown as MealRecord,
    });
    const response = await POST(jsonRequest(JSON.stringify({
      ...meal, version: 1, items: [{ ...meal.items[0], unit: "ml" }],
    })));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.record.items[0].nutritionMatch.includedInTotal).toBe(false);
    expect(body.record.items[0].nutritionMatch.profile).toBeNull();
    expect(reserveHourlyUsdaCall).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(commitMeal).toHaveBeenCalledOnce();
  });

  it.each([
    { admission: { allowed: false, retryAfterSeconds: 30 }, label: "exhausted" },
    { admission: new Error("quota storage unavailable"), label: "unavailable" },
  ])("saves honest unresolved coverage when USDA budget is $label", async ({ admission }) => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    if (admission instanceof Error)
      vi.mocked(reserveHourlyUsdaCall).mockRejectedValue(admission);
    else
      vi.mocked(reserveHourlyUsdaCall).mockResolvedValue(admission);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const liveMeal = { ...meal, mode: "live", items: [{
      ...meal.items[0], id: "unknown", displayName: "mystery food", normalizedName: "mystery food",
    }] };
    const response = await POST(jsonRequest(JSON.stringify(liveMeal)));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.record.items[0].nutritionMatch.includedInTotal).toBe(false);
    expect(body.record.items[0].nutritionMatch.profile).toBeNull();
    expect(body.record.items[0].nutritionMatch.reasons).toContain(copy.nutritionLookupFailed);
    expect(commitMeal).toHaveBeenCalledOnce();
    expect(reserveHourlyUsdaCall).toHaveBeenCalledOnce();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(["ml", "piece", "bowl", "cup"] as const)(
    "saves an unknown %s portion without a futile USDA quota reservation or fetch",
    async (unit) => {
      vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);
      const liveMeal = { ...meal, mode: "live", items: [{
        ...meal.items[0], id: "unknown", displayName: "mystery food",
        normalizedName: "mystery food", unit,
      }] };

      const response = await POST(jsonRequest(JSON.stringify(liveMeal)));
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.record.items[0].nutritionMatch.profile).toBeNull();
      expect(body.record.items[0].nutritionMatch.includedInTotal).toBe(false);
      expect(commitMeal).toHaveBeenCalledOnce();
      expect(reserveHourlyUsdaCall).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("does not repeat nutrition lookup work for a note-only edit", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const item = {
      ...meal.items[0],
      id: "unknown",
      displayName: "mystery food",
      normalizedName: "mystery food",
      identityLevel: "ingredient" as const,
      unit: "g" as const,
    };
    const unresolved = new LocalNutritionProvider().resolve(item);
    expect(unresolved.includedInTotal).toBe(false);
    const previous: MealRecord = {
      ...(meal as unknown as MealRecord),
      mode: "live",
      version: 1,
      mutationId: "33333333-3333-4333-8333-333333333333",
      userId: "qa-user",
      updatedAt: "2026-10-07T00:00:00.000Z",
      schemaVersion: CURRENT_MEAL_SCHEMA_VERSION,
      createdAt: "2026-10-07T00:00:00.000Z",
      photoRef: null,
      journalNote: "舊備註",
      analysisProvenance: null,
      originalItems: [item],
      items: [{ ...item, nutritionMatch: unresolved }],
    };
    vi.mocked(previousMeal).mockResolvedValue({
      deleted: false,
      version: 1,
      mutationId: previous.mutationId,
      record: previous,
    });

    const response = await POST(jsonRequest(JSON.stringify({
      ...meal,
      mode: "live",
      version: 1,
      mutationId: "44444444-4444-4444-8444-444444444444",
      items: [item],
      journalNote: "新備註",
    })));

    expect(response.status).toBe(200);
    expect(reserveHourlyUsdaCall).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    const candidate = vi.mocked(commitMeal).mock.calls[0][2] as MealRecord;
    expect(candidate.journalNote).toBe("新備註");
    expect(candidate.items[0].nutritionMatch).toEqual(unresolved);
  });

  it("changes the durable mutation fingerprint when only the journal note changes", async () => {
    const first = await POST(jsonRequest(JSON.stringify({
      ...meal, journalNote: "第一版",
    })));
    expect(first.status).toBe(200);
    const firstFingerprint = vi.mocked(claimMealLookupAttempt).mock.calls.at(-1)?.[1].fingerprint;

    const second = await POST(jsonRequest(JSON.stringify({
      ...meal, journalNote: "第二版",
    })));
    expect(second.status).toBe(200);
    const secondFingerprint = vi.mocked(claimMealLookupAttempt).mock.calls.at(-1)?.[1].fingerprint;

    expect(firstFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(secondFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(secondFingerprint).not.toBe(firstFingerprint);
  });

  it("keeps a concurrent same-mutation save retryable before any USDA request", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    vi.mocked(claimMealLookupAttempt).mockResolvedValue({ state: "busy", retryAfterSeconds: 20 });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const liveMeal = { ...meal, mode: "live", items: [{
      ...meal.items[0], id: "unknown", displayName: "mystery food", normalizedName: "mystery food",
    }] };
    const response = await POST(jsonRequest(JSON.stringify(liveMeal)));
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: { code: "operation_in_progress" } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reserveHourlyUsdaCall).not.toHaveBeenCalled();
    expect(commitMeal).not.toHaveBeenCalled();
  });

  it("saves a lease-expired retry with unresolved coverage and no second provider call", async () => {
    vi.mocked(getNutritionApiKey).mockReturnValue("test-only-key");
    vi.mocked(claimMealLookupAttempt).mockResolvedValue({ state: "fallback", token: "retry-token" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const liveMeal = { ...meal, mode: "live", items: [{
      ...meal.items[0], id: "unknown", displayName: "mystery food", normalizedName: "mystery food",
    }] };
    const response = await POST(jsonRequest(JSON.stringify(liveMeal)));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.record.items[0].nutritionMatch.includedInTotal).toBe(false);
    expect(body.record.items[0].nutritionMatch.reasons).toContain(copy.nutritionLookupFailed);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(reserveHourlyUsdaCall).not.toHaveBeenCalled();
    expect(commitMeal).toHaveBeenCalledOnce();
    expect(releaseMealLookupAttempt).toHaveBeenCalledOnce();
  });

  it.each([undefined, "8"])(
    "cancels actual oversized JSON before parsing with content-length %s",
    async (contentLength) => {
      const cancel = vi.fn();
      let pulls = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          controller.enqueue(new Uint8Array(pulls === 1 ? 1 : 450_000));
        },
        cancel,
      }, { highWaterMark: 0 });
      const headers = new Headers({ "content-type": "application/json" });
      if (contentLength !== undefined) headers.set("content-length", contentLength);
      const request = new Request("http://localhost/api/meals", {
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
      expect(previousMeal).not.toHaveBeenCalled();
      expect(commitMeal).not.toHaveBeenCalled();
    },
  );

  it("keeps the 150,000-character allowance for UTF-8 JSON", async () => {
    const empty = JSON.stringify({ ...meal, padding: "" });
    const text = JSON.stringify({ ...meal, padding: "飯".repeat(150_000 - empty.length) });
    expect(text.length).toBe(150_000);
    expect(new TextEncoder().encode(text).length).toBeGreaterThan(400_000);

    const response = await POST(jsonRequest(text));

    expect(response.status).toBe(200);
    expect(commitMeal).toHaveBeenCalledOnce();
  });

  it("still rejects decoded text above the existing character limit", async () => {
    const empty = JSON.stringify({ ...meal, padding: "" });
    const text = JSON.stringify({ ...meal, padding: "a".repeat(150_001 - empty.length) });
    const response = await POST(jsonRequest(text));

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "invalid_request" } });
    expect(commitMeal).not.toHaveBeenCalled();
  });

  it("returns a controlled error for malformed JSON", async () => {
    const response = await POST(jsonRequest('{"private-input":'));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request" } });
    expect(commitMeal).not.toHaveBeenCalled();
  });

  it("returns a controlled error for an interrupted input stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) { controller.error(new Error("private transport details")); },
    });
    const response = await POST(new Request("http://localhost/api/meals", {
      method: "POST", body: stream, duplex: "half",
    } as RequestInit));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid_request" } });
    expect(commitMeal).not.toHaveBeenCalled();
  });

  it("checks authentication before reading the meal body", async () => {
    authorize.mockRejectedValueOnce(new HttpError(401, "login_required"));
    const request = jsonRequest(JSON.stringify(meal));
    const getReader = vi.spyOn(request.body!, "getReader");
    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: { code: "login_required" } });
    expect(getReader).not.toHaveBeenCalled();
    expect(commitMeal).not.toHaveBeenCalled();
  });
});
