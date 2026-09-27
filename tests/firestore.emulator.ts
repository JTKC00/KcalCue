import { beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { initializeApp, deleteApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import {
  initializeApp as clientApp,
  deleteApp as deleteClient,
} from "firebase/app";
import {
  getFirestore as clientDb,
  connectFirestoreEmulator,
  doc,
  getDoc,
  setDoc,
  terminate,
} from "firebase/firestore";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { CURRENT_MEAL_SCHEMA_VERSION, dayNutrition, newDraft, type MealRecord } from "@/lib/meals/types";
import { dayCalories } from "@/lib/meals/calories";
import { assertWritableMealSchema, commitMeal, mealCollection, previousMeal } from "@/lib/firebase/meals";
import { accountPath } from "@/lib/firebase/admin";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";
import { provenance } from "@/test/provenance-fixture";
import { reserveDailyLiveAnalysis } from "@/lib/server/durable-analysis-quota";
import { reserveHourlyUsdaCall } from "@/lib/server/durable-nutrition-quota";
import { clearUsdaCache } from "@/lib/nutrition/usda";
import { isCompositeIdentity } from "@/lib/nutrition/canonical";
import { getNutritionApiKey } from "@/lib/server/env";
import { claimMealLookupAttempt, releaseMealLookupAttempt } from "@/lib/server/meal-lookup-attempt";

const fixture = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()),
  authenticated: fixture.auth,
}));
import { GET, POST } from "@/app/api/meals/route";
import { DELETE } from "@/app/api/meals/[id]/route";
import { HttpError } from "@/lib/server/auth";

if (
  !process.env.FIRESTORE_EMULATOR_HOST ||
  !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)
)
  throw new Error(
    "Requires local Firestore emulator; refuses live project access",
  );
const app = initializeApp({ projectId: "demo-kcalcue" }, "emulator-test");
const db = getFirestore(app);
const uid = "test-user-a";
beforeEach(async () => {
  vi.restoreAllMocks();
  await db.recursiveDelete(db.collection("kcalcueUsers"));
  await db.recursiveDelete(db.collection("kcalcueAnalysisUsage"));
  await db.recursiveDelete(db.collection("kcalcueUsdaUsage"));
  fixture.auth.mockReset().mockResolvedValue({ db, user: { id: uid } });
});

describe("durable Live analysis quota against real Firestore emulator", () => {
  const limits = { perUser: 2, project: 3 };
  const beforeMidnight = Date.UTC(2026, 8, 27, 23, 59, 59);
  const nextDay = Date.UTC(2026, 8, 28, 0, 0, 0);

  it("atomically admits one competing attempt and persists across server instances", async () => {
    const sameUser = await Promise.all([
      reserveDailyLiveAnalysis(db, uid, beforeMidnight, { perUser: 1, project: 3 }),
      reserveDailyLiveAnalysis(db, uid, beforeMidnight, { perUser: 1, project: 3 }),
    ]);
    expect(sameUser.map((result) => result.allowed).sort()).toEqual([false, true]);
    expect(sameUser.find((result) => !result.allowed)?.retryAfterSeconds).toBe(1);

    const secondApp = initializeApp({ projectId: "demo-kcalcue" }, "quota-second-instance");
    const secondDb = getFirestore(secondApp);
    try {
      expect((await reserveDailyLiveAnalysis(secondDb, uid, beforeMidnight, { perUser: 1, project: 3 })).allowed).toBe(false);
      expect((await reserveDailyLiveAnalysis(secondDb, "other-user", beforeMidnight, { perUser: 1, project: 3 })).allowed).toBe(true);
    } finally {
      await secondDb.terminate();
      await deleteApp(secondApp);
    }
    const day = await db.collection("kcalcueAnalysisUsage").doc("2026-09-27").get();
    expect(day.data()?.count).toBe(2);
    const users = await day.ref.collection("users").get();
    expect(users.size).toBe(2);
    expect(users.docs.every((doc) => doc.id !== uid && doc.id !== "other-user")).toBe(true);
  });

  it("enforces a project-wide ceiling without writing rejected attempts", async () => {
    for (const user of ["a", "b", "c"]) {
      expect((await reserveDailyLiveAnalysis(db, user, beforeMidnight, limits)).allowed).toBe(true);
    }
    expect((await reserveDailyLiveAnalysis(db, "d", beforeMidnight, limits)).allowed).toBe(false);
    const day = await db.collection("kcalcueAnalysisUsage").doc("2026-09-27").get();
    expect(day.data()?.count).toBe(3);
    expect((await day.ref.collection("users").get()).size).toBe(3);
  });

  it("starts a fresh UTC day and rejects malformed stored quota state", async () => {
    expect((await reserveDailyLiveAnalysis(db, uid, beforeMidnight, { perUser: 1, project: 1 })).allowed).toBe(true);
    expect((await reserveDailyLiveAnalysis(db, uid, beforeMidnight, { perUser: 1, project: 1 })).allowed).toBe(false);
    expect((await reserveDailyLiveAnalysis(db, uid, nextDay, { perUser: 1, project: 1 })).allowed).toBe(true);
    const nextDayRef = db.collection("kcalcueAnalysisUsage").doc("2026-09-28");
    expect((await nextDayRef.get()).data()?.count).toBe(1);
    await nextDayRef.set({ count: "corrupt" });
    await expect(reserveDailyLiveAnalysis(db, "another-user", nextDay)).rejects.toThrow("Invalid analysis quota state");
  });
});

describe("durable USDA hourly quota against real Firestore emulator", () => {
  const beforeHour = Date.UTC(2026, 8, 27, 23, 59, 59);
  const nextHour = Date.UTC(2026, 8, 28, 0, 0, 0);

  it("admits only one competing call for the same user across server instances", async () => {
    const secondApp = initializeApp({ projectId: "demo-kcalcue" }, "usda-quota-second-instance");
    const secondDb = getFirestore(secondApp);
    try {
      const results = await Promise.all([
        reserveHourlyUsdaCall(db, uid, beforeHour, { perUser: 1, project: 3 }),
        reserveHourlyUsdaCall(secondDb, uid, beforeHour, { perUser: 1, project: 3 }),
      ]);
      expect(results.map((result) => result.allowed).sort()).toEqual([false, true]);
      expect(results.find((result) => !result.allowed)?.retryAfterSeconds).toBe(1);
      const hour = await db.collection("kcalcueUsdaUsage").doc("2026-09-27T23").get();
      expect(hour.data()?.count).toBe(1);
      const users = await hour.ref.collection("users").get();
      expect(users.size).toBe(1);
      expect(users.docs[0]?.data().count).toBe(1);
      expect(users.docs[0]?.id).not.toBe(uid);
    } finally {
      await secondDb.terminate();
      await deleteApp(secondApp);
    }
  });

  it("enforces the shared project ceiling without writing rejected reservations", async () => {
    const limits = { perUser: 2, project: 3 };
    for (const user of ["a", "b", "c"]) {
      expect((await reserveHourlyUsdaCall(db, user, beforeHour, limits)).allowed).toBe(true);
    }
    const rejected = await reserveHourlyUsdaCall(db, "d", beforeHour, limits);
    expect(rejected).toEqual({ allowed: false, retryAfterSeconds: 1 });
    const hour = await db.collection("kcalcueUsdaUsage").doc("2026-09-27T23").get();
    expect(hour.data()?.count).toBe(3);
    expect((await hour.ref.collection("users").get()).size).toBe(3);
  });

  it("admits a full twelve-food meal under simultaneous reservations", async () => {
    const results = await Promise.all(Array.from({ length: 12 }, () =>
      reserveHourlyUsdaCall(db, uid, beforeHour)));
    expect(results.every((result) => result.allowed)).toBe(true);
    const hour = await db.collection("kcalcueUsdaUsage").doc("2026-09-27T23").get();
    expect(hour.data()?.count).toBe(12);
    const user = await hour.ref.collection("users").get();
    expect(user.docs[0]?.data().count).toBe(12);
  });

  it("starts a fresh UTC hour and fails closed on malformed stored counters or input", async () => {
    const limits = { perUser: 1, project: 1 };
    expect((await reserveHourlyUsdaCall(db, uid, beforeHour, limits)).allowed).toBe(true);
    expect((await reserveHourlyUsdaCall(db, uid, beforeHour, limits)).allowed).toBe(false);
    expect((await reserveHourlyUsdaCall(db, uid, nextHour, limits)).allowed).toBe(true);
    const nextHourRef = db.collection("kcalcueUsdaUsage").doc("2026-09-28T00");
    expect((await nextHourRef.get()).data()?.count).toBe(1);
    await nextHourRef.set({ count: "corrupt" });
    await expect(reserveHourlyUsdaCall(db, "another-user", nextHour)).rejects.toThrow("Invalid USDA quota state");
    expect((await nextHourRef.get()).data()?.count).toBe("corrupt");
    expect((await nextHourRef.collection("users").get()).size).toBe(1);
    const previousHourRef = db.collection("kcalcueUsdaUsage").doc("2026-09-27T23");
    const previousUser = (await previousHourRef.collection("users").get()).docs[0];
    if (!previousUser) throw new Error("Expected the admitted user's quota document");
    await previousUser.ref.set({ count: -1 });
    await expect(reserveHourlyUsdaCall(db, uid, beforeHour, { perUser: 2, project: 2 })).rejects.toThrow("Invalid USDA quota state");
    expect((await previousHourRef.get()).data()?.count).toBe(1);
    await expect(reserveHourlyUsdaCall(db, " ", nextHour)).rejects.toThrow("Invalid USDA quota input");
    await expect(reserveHourlyUsdaCall(db, uid, Number.MAX_SAFE_INTEGER)).rejects.toThrow("Invalid USDA quota input");
    await expect(reserveHourlyUsdaCall(db, uid, nextHour, { perUser: 0, project: 1 })).rejects.toThrow("Invalid USDA quota input");
  });
});

describe("meal USDA lookup attempt lease against real Firestore emulator", () => {
  const nowMs = Date.UTC(2026, 8, 27, 12, 0, 0);
  const fingerprint = "a".repeat(64);
  function claim(
    database: typeof db,
    fields: Partial<Parameters<typeof claimMealLookupAttempt>[1]> = {},
  ) {
    return claimMealLookupAttempt(database, {
      uid,
      mealId: "11111111-1111-4111-8111-111111111111",
      mutationId: "22222222-2222-4222-8222-222222222222",
      expectedVersion: 0,
      fingerprint,
      nowMs,
      ...fields,
    });
  }

  it("lets one of two server instances claim a mutation and keeps the other busy", async () => {
    const secondApp = initializeApp({ projectId: "demo-kcalcue" }, "lookup-second-instance");
    const secondDb = getFirestore(secondApp);
    try {
      const results = await Promise.all([claim(db), claim(secondDb)]);
      expect(results.map((result) => result.state).sort()).toEqual(["busy", "claimed"]);
      expect(results.find((result) => result.state === "busy")).toEqual({
        state: "busy", retryAfterSeconds: 120,
      });
      expect((await db.doc(`kcalcueUsers/${uid}/mealLookupAttempts/11111111-1111-4111-8111-111111111111`).get()).data()).toMatchObject({
        mutationId: "22222222-2222-4222-8222-222222222222",
        fingerprint,
        expectedVersion: 0,
        state: "active",
      });
    } finally {
      await secondDb.terminate();
      await deleteApp(secondApp);
    }
  });

  it("never grants a second remote lookup for the same mutation after expiry or release", async () => {
    const first = await claim(db);
    expect(first.state).toBe("claimed");
    if (first.state !== "claimed") throw new Error("Expected first claim");
    const expired = await claim(db, { nowMs: nowMs + 120_001 });
    expect(expired.state).toBe("fallback");
    if (expired.state !== "fallback") throw new Error("Expected local fallback claim");
    expect(expired.token).not.toBe(first.token);
    expect(await releaseMealLookupAttempt(db, {
      uid, mealId: "11111111-1111-4111-8111-111111111111", token: first.token,
    })).toBe(false);
    expect((await claim(db, { nowMs: nowMs + 120_001 })).state).toBe("busy");
    expect(await releaseMealLookupAttempt(db, {
      uid, mealId: "11111111-1111-4111-8111-111111111111", token: expired.token,
    })).toBe(true);
    expect((await claim(db, { nowMs: nowMs + 120_002 })).state).toBe("fallback");
  });

  it("admits a different mutation after lease expiry only at the current meal version", async () => {
    const first = await claim(db);
    expect(first.state).toBe("claimed");
    const nextMutation = "33333333-3333-4333-8333-333333333333";
    expect((await claim(db, { mutationId: nextMutation, nowMs: nowMs + 120_001 })).state).toBe("claimed");
    if (first.state !== "claimed") throw new Error("Expected first claim");
    expect(await releaseMealLookupAttempt(db, {
      uid, mealId: "11111111-1111-4111-8111-111111111111", token: first.token,
    })).toBe(false);
    await expect(claim(db, { mutationId: nextMutation, expectedVersion: 1, nowMs: nowMs + 240_002 })).rejects.toMatchObject({
      status: 409, code: "conflict",
    });
  });

  it("acknowledges committed mutation before another lookup and rejects stale or changed input", async () => {
    const committed = await seedLegacy();
    expect(await claim(db, {
      mealId: committed.id,
      mutationId: committed.mutationId,
      expectedVersion: committed.version - 1,
    })).toEqual({ state: "committed", record: committed });
    await expect(claim(db, { mealId: committed.id, expectedVersion: 0 })).rejects.toMatchObject({
      status: 409, code: "conflict",
    });
    await claim(db);
    await expect(claim(db, { fingerprint: "b".repeat(64) })).rejects.toMatchObject({
      status: 409, code: "conflict",
    });
    await expect(claim(db, { mutationId: "33333333-3333-4333-8333-333333333333" })).resolves.toMatchObject({
      state: "busy",
    });
  });

  it("isolates attempts by account and fails closed on malformed state", async () => {
    expect((await claim(db)).state).toBe("claimed");
    expect((await claim(db, { uid: "other-user" })).state).toBe("claimed");
    expect((await db.doc(`kcalcueUsers/${uid}/mealLookupAttempts/11111111-1111-4111-8111-111111111111`).get()).exists).toBe(true);
    expect((await db.doc("kcalcueUsers/other-user/mealLookupAttempts/11111111-1111-4111-8111-111111111111").get()).exists).toBe(true);
    await expect(claim(db, { uid: "other/user" })).rejects.toMatchObject({ status: 400 });
    const malformed = db.doc(`kcalcueUsers/${uid}/mealLookupAttempts/11111111-1111-4111-8111-111111111111`);
    await malformed.set({ mutationId: "corrupt" });
    await expect(claim(db)).rejects.toThrow("Invalid meal lookup attempt state");
  });

  it("rejects deleted and future-schema meals before claiming a lookup", async () => {
    const deleted = await seedLegacy();
    await mealCollection(db, uid).doc(deleted.id).update({ deleted: true });
    await expect(claim(db, { mealId: deleted.id, expectedVersion: deleted.version })).rejects.toMatchObject({
      status: 409, code: "conflict",
    });
    const future = await seedLegacy({ schemaVersion: 900 });
    await expect(claim(db, { mealId: future.id, expectedVersion: future.version })).rejects.toMatchObject({
      status: 409, code: "unsupported_schema",
    });
    expect((await db.collection(`kcalcueUsers/${uid}/mealLookupAttempts`).get()).size).toBe(0);
  });

  it("lets one cross-instance meal POST fetch USDA while a same-mutation retry waits", async () => {
    const secondApp = initializeApp({ projectId: "demo-kcalcue" }, "lookup-route-second-instance");
    const secondDb = getFirestore(secondApp);
    vi.stubEnv("NUTRITION_API_KEY", "test-only-key");
    clearUsdaCache();
    let finishFetch!: (value: Response) => void;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { finishFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    fixture.auth.mockImplementation(async (request: Request) => ({
      db: request.headers.get("x-qa-instance") === "two" ? secondDb : db,
      user: { id: uid },
    }));
    try {
      const body = input();
      body.mode = "live";
      body.items = [{
        id: crypto.randomUUID(), displayName: "mystery food",
        normalizedName: "mystery food", identityLevel: "ingredient",
        portionMin: 100, portionMax: 120,
        originalPortionMin: 100, originalPortionMax: 120,
        unit: "g", recognitionConfidence: 0.8, portionConfidence: 0.7,
        uncertaintyReasons: [],
      }];
      expect(getNutritionApiKey()).toBe("test-only-key");
      const localMatch = new LocalNutritionProvider().resolve(body.items[0]);
      expect(localMatch.includedInTotal).toBe(false);
      expect(isCompositeIdentity(localMatch.identity)).toBe(false);
      const first = POST(request(body));
      await Promise.race([
        vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce()),
        first.then((response) => { throw new Error(`First meal POST returned ${response.status} before USDA fetch`); }),
      ]);
      const changed = await POST(new Request("http://localhost/api/meals", {
        method: "POST", headers: { "x-qa-instance": "two" },
        body: JSON.stringify({
          ...body, mode: "manual", items: [{
            ...body.items[0], displayName: "banana", normalizedName: "banana",
          }],
        }),
      }));
      expect(changed.status).toBe(409);
      expect(await changed.json()).toEqual({ error: { code: "conflict" } });
      const second = await POST(new Request("http://localhost/api/meals", {
        method: "POST", headers: { "x-qa-instance": "two" }, body: JSON.stringify(body),
      }));
      expect(second.status).toBe(503);
      expect(await second.json()).toEqual({ error: { code: "operation_in_progress" } });
      finishFetch(Response.json({ foods: [] }));
      const saved = await first;
      expect(saved.status).toBe(200);
      expect((await saved.json()).record.items[0].nutritionMatch.includedInTotal).toBe(false);
      expect((await POST(request(body))).status).toBe(200);
      expect(fetchMock).toHaveBeenCalledOnce();
      expect((await db.collection("kcalcueUsdaUsage").get()).docs[0]?.data().count).toBe(1);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
      clearUsdaCache();
      await secondDb.terminate();
      await deleteApp(secondApp);
    }
  });
});

afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});
function input() {
  return {
    ...newDraft(),
    mutationId: crypto.randomUUID(),
    items: createEditableFoodItems(demoFoodAnalysis.foods),
  };
}
function request(body: unknown) {
  return new Request("http://localhost/api/meals", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
async function seedLegacy(fields: Record<string, unknown> = {}) {
  const body = input();
  const record = JSON.parse(JSON.stringify({
    ...body,
    userId: uid,
    version: 1,
    updatedAt: "2020-01-02T03:04:05.000Z",
    originalItems: body.items,
    ...fields,
  })) as MealRecord;
  await mealCollection(db, uid).doc(record.id).set({
    deleted: false, version: record.version, mutationId: record.mutationId, record,
  });
  await db.doc(accountPath(uid)).set({ revision: crypto.randomUUID() });
  return record;
}

describe("Firebase meal API against real Firestore emulator", () => {
  it("persists client-reported provenance once across edits, retries, reads and copy-as-new", async () => {
    const body = { ...input(), mode: "live", analysis: demoFoodAnalysis,
      analysisProvenance: { ...provenance, source: "server-verified", verified: true } };
    const created = (await (await POST(request(body))).json()).record;
    expect(created.analysisProvenance).toEqual(provenance);
    expect(created.schemaVersion).toBe(3);
    const edit = { ...created, mutationId: crypto.randomUUID(), analysis: null, analysisProvenance: null, time: "22:00" };
    const saved = (await (await POST(request(edit))).json()).record;
    expect(saved.analysisProvenance).toEqual(provenance);
    expect(saved.analysis).toEqual(demoFoodAnalysis);
    const before = await mealCollection(db, uid).doc(body.id).get();
    expect((await (await POST(request(edit))).json()).record).toEqual(saved);
    expect((await mealCollection(db, uid).doc(body.id).get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
    expect((await (await GET(new Request("http://localhost/api/meals"))).json()).records).toEqual([saved]);
    const copy = (await (await POST(request({ ...saved, id: crypto.randomUUID(), version: 0,
      mutationId: crypto.randomUUID(), createdAt: "1900-01-01T00:00:00.000Z" }))).json()).record;
    expect(copy.id).not.toBe(saved.id);
    expect(copy.createdAt).not.toBe("1900-01-01T00:00:00.000Z");
    expect(copy.analysisProvenance).toEqual(provenance);
    expect(copy.analysis).toEqual(saved.analysis);
  });
  it("keeps legacy provenance absent on read and unknown on an edit that tries to backfill it", async () => {
    const legacy = await seedLegacy({ schemaVersion: 2, mode: "live", analysis: demoFoodAnalysis, analysisProvenance: undefined });
    const before = await mealCollection(db, uid).doc(legacy.id).get();
    expect((await (await GET(new Request("http://localhost/api/meals"))).json()).records[0]).not.toHaveProperty("analysisProvenance");
    expect((await mealCollection(db, uid).doc(legacy.id).get()).updateTime!.isEqual(before.updateTime!)).toBe(true);
    const saved = (await (await POST(request({ ...legacy, mutationId: crypto.randomUUID(), analysisProvenance: provenance }))).json()).record;
    expect(saved.analysisProvenance).toBeNull();
    expect(saved.analysis).toEqual(legacy.analysis);
    expect(saved.schemaVersion).toBe(3);
  });
  it("recomputes nutrition, strips image fields, and acknowledges a repeated mutation once", async () => {
    const body = {
      ...input(), image: "private image", photo: "private photo",
      schemaVersion: 99, createdAt: "1900-01-01T00:00:00.000Z",
      updatedAt: "1900-01-01T00:00:00.000Z", userId: "untrusted-user",
    };
    const started = Date.now();
    const first = await POST(request(body));
    expect(first.status).toBe(200);
    const saved = (await first.json()).record;
    expect(saved.items[0].nutritionMatch.profile).toBeTruthy();
    expect(saved.version).toBe(1);
    expect(saved.schemaVersion).toBe(CURRENT_MEAL_SCHEMA_VERSION);
    expect(saved.userId).toBe(uid);
    expect(saved.createdAt).toBe(saved.updatedAt);
    expect(Date.parse(saved.createdAt)).toBeGreaterThanOrEqual(started);
    expect(Date.parse(saved.createdAt)).toBeLessThanOrEqual(Date.now());
    const beforeRetry = await mealCollection(db, uid).doc(body.id).get();
    const revision = (await db.doc(accountPath(uid)).get()).data()?.revision;
    expect((await (await POST(request(body))).json()).record).toEqual(saved);
    const afterRetry = await mealCollection(db, uid).doc(body.id).get();
    expect(afterRetry.updateTime?.isEqual(beforeRetry.updateTime!)).toBe(true);
    expect((await db.doc(accountPath(uid)).get()).data()?.revision).toBe(revision);
    const stored = await mealCollection(db, uid).get();
    expect(stored.size).toBe(1);
    expect(JSON.stringify(stored.docs[0].data())).not.toContain(
      "private image",
    );
    expect(JSON.stringify(stored.docs[0].data())).not.toContain(
      "private photo",
    );
  });
  it("preserves the original analysis and rejects a competing device's stale edit", async () => {
    const body = { ...input(), analysis: demoFoodAnalysis };
    const created = (await (await POST(request(body))).json()).record;
    const updated = await POST(
      request({
        ...created,
        mutationId: crypto.randomUUID(),
        analysis: null,
        items: created.items.map((item: object) => ({
          ...item,
          portionMin: 200,
          portionMax: 300,
        })),
      }),
    );
    expect(updated.status).toBe(200);
    const record = (await updated.json()).record;
    expect(record.analysis).toEqual(demoFoodAnalysis);
    expect(record.originalItems).toEqual(created.originalItems);
    expect(record.items[0].portionMin).toBe(200);
    expect(record.version).toBe(2);
    expect(
      (await POST(request({ ...created, mutationId: crypto.randomUUID() })))
        .status,
    ).toBe(409);
  });
  it("atomically accepts only one of two simultaneous version-zero writes", async () => {
    const body = input();
    const results = await Promise.all([
      POST(request(body)),
      POST(
        request({ ...body, mutationId: crypto.randomUUID(), time: "14:00" }),
      ),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const winner = (await results.find((response) => response.status === 200)!.json()).record;
    expect(winner.schemaVersion).toBe(CURRENT_MEAL_SCHEMA_VERSION);
    expect(winner.createdAt).toBe(winner.updatedAt);
    expect((await mealCollection(db, uid).doc(body.id).get()).data()?.record).toEqual(winner);
  });
  it("acknowledges concurrent identical creates with exactly the same server timestamps", async () => {
    const body = input();
    const responses = await Promise.all([POST(request(body)), POST(request(body))]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const records = await Promise.all(responses.map(async (response) => (await response.json()).record));
    expect(records[0]).toEqual(records[1]);
    expect(records[0].version).toBe(1);
    expect(records[0].createdAt).toBe(records[0].updatedAt);
  });
  it("reads a legacy meal without backfilling metadata or changing revision", async () => {
    const legacy = await seedLegacy();
    const ref = mealCollection(db, uid).doc(legacy.id);
    const before = await ref.get();
    const accountBefore = await db.doc(accountPath(uid)).get();
    const response = await GET(new Request("http://localhost/api/meals"));
    expect(response.status).toBe(200);
    expect((await response.json()).records).toEqual([legacy]);
    expect(legacy).not.toHaveProperty("createdAt");
    expect(legacy).not.toHaveProperty("schemaVersion");
    const after = await ref.get();
    const accountAfter = await db.doc(accountPath(uid)).get();
    expect(after.data()).toEqual(before.data());
    expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true);
    expect(accountAfter.data()).toEqual(accountBefore.data());
    expect(accountAfter.updateTime?.isEqual(accountBefore.updateTime!)).toBe(true);
  });
  it.each([undefined, 0, 1, 2])("upgrades legacy schema %s on edit without inventing a creation time", async (schemaVersion) => {
    const legacy = await seedLegacy({ schemaVersion, analysis: demoFoodAnalysis });
    const response = await POST(request({ ...legacy, mutationId: crypto.randomUUID() }));
    expect(response.status).toBe(200);
    const saved = (await response.json()).record;
    expect(saved.schemaVersion).toBe(CURRENT_MEAL_SCHEMA_VERSION);
    expect(saved.createdAt).toBeNull();
    expect(saved.updatedAt).not.toBe(legacy.updatedAt);
    expect(saved.analysis).toEqual(legacy.analysis);
    expect(saved.originalItems).toEqual(legacy.originalItems);
  });
  it("keeps a valid stored creation time for old clients and forged metadata edits", async () => {
    const body = input();
    const created = (await (await POST(request(body))).json()).record;
    const oldClient = { ...body, version: 1, mutationId: crypto.randomUUID() };
    const updated = (await (await POST(request(oldClient))).json()).record;
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.schemaVersion).toBe(CURRENT_MEAL_SCHEMA_VERSION);
    const forged = await POST(request({
      ...updated, mutationId: crypto.randomUUID(), schemaVersion: 900,
      createdAt: "1900-01-01T00:00:00.000Z", updatedAt: "1900-01-01T00:00:00.000Z",
    }));
    expect(forged.status).toBe(200);
    const saved = (await forged.json()).record;
    expect(saved.createdAt).toBe(created.createdAt);
    expect(saved.schemaVersion).toBe(CURRENT_MEAL_SCHEMA_VERSION);
    expect(saved.updatedAt).not.toBe("1900-01-01T00:00:00.000Z");
  });
  it.each([null, "not-a-time", "2020-99-99T99:99:99Z"])("keeps malformed or unknown legacy creation %s unknown", async (createdAt) => {
    const legacy = await seedLegacy({ createdAt });
    const response = await POST(request({ ...legacy, mutationId: crypto.randomUUID() }));
    expect(response.status).toBe(200);
    expect((await response.json()).record.createdAt).toBeNull();
  });
  it("preserves a valid UTC legacy creation timestamp without changing its representation", async () => {
    const legacy = await seedLegacy({ createdAt: "2020-01-02T03:04:05Z" });
    const response = await POST(request({ ...legacy, mutationId: crypto.randomUUID() }));
    expect(response.status).toBe(200);
    expect((await response.json()).record.createdAt).toBe(legacy.createdAt);
  });
  it.each([CURRENT_MEAL_SCHEMA_VERSION + 1, "1", null])("refuses stored schema %j before nutrition and leaves cloud data untouched", async (schemaVersion) => {
    const previous = await seedLegacy({ schemaVersion, futureField: "preserve" });
    const ref = mealCollection(db, uid).doc(previous.id);
    const before = await ref.get();
    const revision = (await db.doc(accountPath(uid)).get()).data()?.revision;
    const nutrition = vi.spyOn(LocalNutritionProvider.prototype, "resolve");
    const response = await POST(request({ ...previous, mutationId: crypto.randomUUID(), schemaVersion: 1 }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "unsupported_schema" } });
    expect(nutrition).not.toHaveBeenCalled();
    const after = await ref.get();
    expect(after.data()).toEqual(before.data());
    expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true);
    expect((await db.doc(accountPath(uid)).get()).data()?.revision).toBe(revision);
  });
  it("rechecks schema inside the transaction when a previously writable record has advanced", async () => {
    const previous = await seedLegacy({ schemaVersion: 1 });
    const preflight = await previousMeal(db, uid, previous.id);
    expect(() => assertWritableMealSchema(preflight?.record)).not.toThrow();
    const ref = mealCollection(db, uid).doc(previous.id);
    await ref.update({ "record.schemaVersion": CURRENT_MEAL_SCHEMA_VERSION + 1, "record.futureField": "preserve" });
    const before = await ref.get();
    const revision = (await db.doc(accountPath(uid)).get()).data()?.revision;
    await expect(commitMeal(db, uid, {
      ...previous, version: 2, mutationId: crypto.randomUUID(),
    }, 1)).rejects.toMatchObject({ status: 409, code: "unsupported_schema" });
    const after = await ref.get();
    expect(after.data()).toEqual(before.data());
    expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true);
    expect((await db.doc(accountPath(uid)).get()).data()?.revision).toBe(revision);
  });
  it("acknowledges old or future-schema mutations without a write or implicit metadata upgrade", async () => {
    for (const schemaVersion of [undefined, CURRENT_MEAL_SCHEMA_VERSION + 1]) {
      const previous = await seedLegacy({ schemaVersion });
      const ref = mealCollection(db, uid).doc(previous.id);
      const before = await ref.get();
      const revision = (await db.doc(accountPath(uid)).get()).data()?.revision;
      const response = await POST(request(previous));
      expect(response.status).toBe(200);
      expect((await response.json()).record).toEqual(previous);
      // Transaction-level retry, independent of the route's preflight fast path.
      expect(await commitMeal(db, uid, { ...previous, version: 2 }, 0)).toEqual(previous);
      const after = await ref.get();
      expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true);
      expect((await db.doc(accountPath(uid)).get()).data()?.revision).toBe(revision);
    }
  });
  it("rejects deletion of a future-schema record before changing its revision or tombstone", async () => {
    const previous = await seedLegacy({ schemaVersion: CURRENT_MEAL_SCHEMA_VERSION + 1, futureField: "private" });
    const ref = mealCollection(db, uid).doc(previous.id);
    const before = await ref.get();
    const revision = (await db.doc(accountPath(uid)).get()).data()?.revision;
    const mutationId = crypto.randomUUID();
    const url = `http://localhost/api/meals/${previous.id}?version=1&mutationId=${mutationId}`;
    const response = await DELETE(new Request(url, { method: "DELETE" }), {
      params: Promise.resolve({ id: previous.id }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "unsupported_schema" } });
    const after = await ref.get();
    expect(after.data()).toEqual(before.data());
    expect(after.updateTime?.isEqual(before.updateTime!)).toBe(true);
    expect((await db.doc(accountPath(uid)).get()).data()?.revision).toBe(revision);
  });
  it("persists and clears manual calories for unknown food without fabricating macros or changing original analysis", async () => {
    const body = { ...input(), analysis: demoFoodAnalysis, calorieCorrection: { kcal: 650, source: "ai" },
      calorieInput: "private raw draft", items: createEditableFoodItems([{
        ...demoFoodAnalysis.foods[0], displayName: "QA 未知組合餐", normalizedName: "qa unknown composite",
        identityLevel: "dish", visibleIngredients: undefined, preparationMethod: undefined,
      }]) };
    const created = (await (await POST(request(body))).json()).record as MealRecord;
    expect(created.calorieCorrection).toEqual({ kcal: 650, source: "user" });
    expect(created).not.toHaveProperty("calorieInput");
    expect(created.schemaVersion).toBe(CURRENT_MEAL_SCHEMA_VERSION);
    expect(dayNutrition([created]).coverage).toBe("none");
    expect(dayCalories([created]).range).toEqual({ min: 650, max: 650 });
    const edit = { ...created, mutationId: crypto.randomUUID(), analysis: null, originalItems: [], calorieCorrection: { kcal: 723 } };
    const updated = (await (await POST(request(edit))).json()).record as MealRecord;
    expect(updated.calorieCorrection).toEqual({ kcal: 723, source: "user" });
    expect(updated.analysis).toEqual(created.analysis);
    expect(updated.originalItems).toEqual(created.originalItems);
    expect(updated.createdAt).toBe(created.createdAt);
    expect((await (await POST(request(edit))).json()).record).toEqual(updated);
    const reloaded = (await (await GET(new Request("http://localhost/api/meals"))).json()).records;
    expect(reloaded).toEqual([updated]);
    expect(dayCalories(reloaded).range).toEqual({ min: 723, max: 723 });
    const cleared = (await (await POST(request({ ...updated, mutationId: crypto.randomUUID(), calorieCorrection: null }))).json()).record;
    expect(cleared.calorieCorrection).toBeNull();
    expect(dayCalories([cleared]).range).toBeNull();
    expect(dayNutrition([cleared]).coverage).toBe("none");
  });
  it("preserves an omitted legacy correction for metadata edits but clears it for changed food", async () => {
    const created = (await (await POST(request({ ...input(), calorieCorrection: { kcal: 650 } }))).json()).record as MealRecord;
    const metadata = { ...created, calorieCorrection: undefined, mutationId: crypto.randomUUID(), time: "18:00" };
    const retained = (await (await POST(request(metadata))).json()).record as MealRecord;
    expect(retained.calorieCorrection).toEqual(created.calorieCorrection);
    expect(retained.createdAt).toBe(created.createdAt);
    const changed = { ...retained, calorieCorrection: undefined, mutationId: crypto.randomUUID(),
      items: retained.items.map((item) => ({ ...item, portionMax: item.portionMax + 100 })) };
    const cleared = (await (await POST(request(changed))).json()).record;
    expect(cleared.calorieCorrection).toBeNull();
    expect(cleared.createdAt).toBe(created.createdAt);
  });
  it("accepts only one competing calorie edit and keeps the winning value", async () => {
    const created = (await (await POST(request(input()))).json()).record as MealRecord;
    const responses = await Promise.all([700, 800].map((kcal) => POST(request({
      ...created, mutationId: crypto.randomUUID(), calorieCorrection: { kcal },
    }))));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = (await responses.find((response) => response.status === 200)!.json()).record;
    const stored = (await mealCollection(db, uid).doc(created.id).get()).data()?.record;
    expect(stored).toEqual(winner);
    expect([700, 800]).toContain(stored.calorieCorrection.kcal);
    expect(stored.version).toBe(2);
    expect(stored.createdAt).toBe(created.createdAt);
  });
  it("upgrades a v1 meal to explicit zero while preserving unknown creation time and UID isolation", async () => {
    const legacy = await seedLegacy({ schemaVersion: 1, calorieCorrection: undefined });
    const saved = (await (await POST(request({ ...legacy, mutationId: crypto.randomUUID(), calorieCorrection: { kcal: 0 } }))).json()).record;
    expect(saved.schemaVersion).toBe(CURRENT_MEAL_SCHEMA_VERSION);
    expect(saved.createdAt).toBeNull();
    expect(saved.calorieCorrection).toEqual({ kcal: 0, source: "user" });
    expect(dayCalories([saved]).range).toEqual({ min: 0, max: 0 });
    fixture.auth.mockResolvedValue({ db, user: { id: "test-user-b" } });
    expect((await (await GET(new Request("http://localhost/api/meals"))).json()).records).toEqual([]);
    const foreign = await POST(request({ ...saved, mutationId: crypto.randomUUID(), calorieCorrection: { kcal: 900 } }));
    expect(foreign.status).toBe(409);
    expect((await mealCollection(db, uid).doc(saved.id).get()).data()?.record.calorieCorrection).toEqual({ kcal: 0, source: "user" });
  });
  it("rejects demo data, photo paths and unauthenticated writes", async () => {
    expect((await POST(request({ ...input(), mode: "demo" }))).status).toBe(
      400,
    );
    expect(
      (await POST(request({ ...input(), photoPath: "any/photo.jpg" }))).status,
    ).toBe(400);
    fixture.auth.mockRejectedValueOnce(new HttpError(401, "login_required"));
    expect((await POST(request(input()))).status).toBe(401);
    expect((await mealCollection(db, uid).get()).size).toBe(0);
  });
  it("scrubs deleted meal contents, acknowledges deletion retry and prevents resurrection", async () => {
    const body = input();
    const created = (await (await POST(request(body))).json()).record;
    const url = `http://localhost/api/meals/${body.id}?version=1&mutationId=${crypto.randomUUID()}`;
    const remove = () =>
      DELETE(new Request(url, { method: "DELETE" }), {
        params: Promise.resolve({ id: body.id }),
      });
    expect((await remove()).status).toBe(200);
    expect((await remove()).status).toBe(200);
    const revision = (await db.doc(accountPath(uid)).get()).data()?.revision;
    const secondMutation = crypto.randomUUID();
    const sameVersion = await DELETE(
      new Request(`http://localhost/api/meals/${body.id}?version=1&mutationId=${secondMutation}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: body.id }) },
    );
    expect(sameVersion.status).toBe(200);
    expect((await db.doc(accountPath(uid)).get()).data()?.revision).toBe(revision);
    const staleVersion = await DELETE(
      new Request(`http://localhost/api/meals/${body.id}?version=0&mutationId=${crypto.randomUUID()}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: body.id }) },
    );
    expect(staleVersion.status).toBe(409);
    expect(
      (await mealCollection(db, uid).doc(body.id).get()).data(),
    ).not.toHaveProperty("record");
    expect(
      (await POST(request({ ...created, mutationId: crypto.randomUUID() })))
        .status,
    ).toBe(409);
    expect(
      (await (await GET(new Request("http://localhost/api/meals"))).json())
        .records,
    ).toEqual([]);
  });
  it("isolates API reads and writes by verified UID even when meal IDs match", async () => {
    const body = input();
    await POST(request(body));
    fixture.auth.mockResolvedValue({ db, user: { id: "test-user-b" } });
    expect(
      (await (await GET(new Request("http://localhost/api/meals"))).json())
        .records,
    ).toEqual([]);
    expect(
      (
        await POST(
          request({ ...body, mutationId: crypto.randomUUID(), time: "23:00" }),
        )
      ).status,
    ).toBe(200);
    expect(
      (await mealCollection(db, uid).doc(body.id).get()).data()?.record.time,
    ).toBe(body.time);
  });
  it("checks meals when revision is absent, then short-circuits unchanged known revisions", async () => {
    const initial = await (
      await GET(new Request("http://localhost/api/meals"))
    ).json();
    const unchanged = await (
      await GET(
        new Request(`http://localhost/api/meals?since=${initial.revision}`),
      )
    ).json();
    expect(initial).toEqual({ records: [], revision: "empty" });
    expect(unchanged).toEqual({ records: [], revision: "empty" });
    await POST(request(input()));
    const changed = await (
      await GET(
        new Request(`http://localhost/api/meals?since=${initial.revision}`),
      )
    ).json();
    expect(changed.records).toHaveLength(1);
    expect(changed.revision).not.toBe(initial.revision);
    const knownUnchanged = await (
      await GET(
        new Request(`http://localhost/api/meals?since=${changed.revision}`),
      )
    ).json();
    expect(knownUnchanged).toEqual({ revision: changed.revision });
  });
  it("denies direct Firestore reads and writes even to a signed-in client", async () => {
    const client = clientApp(
      { projectId: "demo-kcalcue", apiKey: "test" },
      "rules-test",
    );
    const firestore = clientDb(client);
    const [host, port] = process.env.FIRESTORE_EMULATOR_HOST!.split(":");
    connectFirestoreEmulator(firestore, host, Number(port), {
      mockUserToken: {
        sub: uid,
        email: "tester@example.com",
        email_verified: true,
      },
    });
    try {
      const ref = doc(firestore, `kcalcueUsers/${uid}/meals/test`);
      await expect(getDoc(ref)).rejects.toMatchObject({
        code: "permission-denied",
      });
      await expect(setDoc(ref, { record: "untrusted" })).rejects.toMatchObject({
        code: "permission-denied",
      });
    } finally {
      await terminate(firestore);
      await deleteClient(client);
    }
  });
});
