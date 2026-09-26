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
import { CURRENT_MEAL_SCHEMA_VERSION, newDraft, type MealRecord } from "@/lib/meals/types";
import { assertWritableMealSchema, commitMeal, mealCollection, previousMeal } from "@/lib/firebase/meals";
import { accountPath } from "@/lib/firebase/admin";
import { LocalNutritionProvider } from "@/lib/nutrition/local-provider";

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
  fixture.auth.mockReset().mockResolvedValue({ db, user: { id: uid } });
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
  it.each([undefined, 0])("upgrades legacy schema %s on edit without inventing a creation time", async (schemaVersion) => {
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
  it.each([2, "1", null])("refuses stored schema %j before nutrition and leaves cloud data untouched", async (schemaVersion) => {
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
    await ref.update({ "record.schemaVersion": 2, "record.futureField": "preserve" });
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
    for (const schemaVersion of [undefined, 2]) {
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
  it("keeps versioned delete and tombstone semantics for future-schema records", async () => {
    const previous = await seedLegacy({ schemaVersion: 2, futureField: "private" });
    const mutationId = crypto.randomUUID();
    const url = `http://localhost/api/meals/${previous.id}?version=1&mutationId=${mutationId}`;
    const response = await DELETE(new Request(url, { method: "DELETE" }), {
      params: Promise.resolve({ id: previous.id }),
    });
    expect(response.status).toBe(200);
    expect((await mealCollection(db, uid).doc(previous.id).get()).data()).toEqual({
      deleted: true, version: 2, mutationId,
    });
    const resurrect = await POST(request({ ...previous, mutationId: crypto.randomUUID() }));
    expect(resurrect.status).toBe(409);
    expect(await resurrect.json()).toMatchObject({ error: { code: "conflict" } });
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
  it("returns only a revision when meals have not changed, and invalidates it on a write", async () => {
    const initial = await (
      await GET(new Request("http://localhost/api/meals"))
    ).json();
    const unchanged = await (
      await GET(
        new Request(`http://localhost/api/meals?since=${initial.revision}`),
      )
    ).json();
    expect(unchanged).not.toHaveProperty("records");
    await POST(request(input()));
    const changed = await (
      await GET(
        new Request(`http://localhost/api/meals?since=${initial.revision}`),
      )
    ).json();
    expect(changed.records).toHaveLength(1);
    expect(changed.revision).not.toBe(initial.revision);
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
