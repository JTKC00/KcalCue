import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authorize = vi.fn();
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  authenticated: (...args: unknown[]) => authorize(...args),
}));
vi.mock("@/lib/firebase/meals", () => ({
  previousMeal: vi.fn(),
  commitMeal: vi.fn(),
  listMeals: vi.fn(),
}));
vi.mock("@/lib/server/env", () => ({ getNutritionApiKey: () => null }));

import { commitMeal, previousMeal } from "@/lib/firebase/meals";
import { HttpError } from "@/lib/server/auth";
import { POST } from "./route";

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

describe("POST /api/meals bounded input", () => {
  beforeEach(() => {
    authorize.mockReset().mockResolvedValue({ db: {}, user: { id: "qa-user" } });
    vi.mocked(previousMeal).mockReset().mockResolvedValue(undefined);
    vi.mocked(commitMeal).mockReset().mockImplementation(async (_db, _userId, record) => record);
  });

  afterEach(() => { vi.restoreAllMocks(); });

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
