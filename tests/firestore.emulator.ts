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
import { newDraft } from "@/lib/meals/types";
import { mealCollection } from "@/lib/firebase/meals";

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

describe("Firebase meal API against real Firestore emulator", () => {
  it("recomputes nutrition, strips image fields, and acknowledges a repeated mutation once", async () => {
    const body = { ...input(), image: "private image", photo: "private photo" };
    const first = await POST(request(body));
    expect(first.status).toBe(200);
    const saved = (await first.json()).record;
    expect(saved.items[0].nutritionMatch.profile).toBeTruthy();
    expect(saved.version).toBe(1);
    expect((await (await POST(request(body))).json()).record).toEqual(saved);
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
