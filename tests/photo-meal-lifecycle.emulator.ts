import { afterAll, describe, expect, it, vi } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { accountPath } from "@/lib/firebase/admin";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { newDraft, type MealRecord } from "@/lib/meals/types";
import { mealCollection } from "@/lib/firebase/meals";
import {
  MAX_PHOTO_JPEG_BYTES, finalizePhotoAsset, photoAssetRef,
  reservePhotoAsset, type PhotoQuotaPolicy,
} from "@/lib/firebase/photo-assets";

const fixture = vi.hoisted(() => ({ auth: vi.fn() }));
vi.mock("@/lib/server/auth", async (original) => ({
  ...(await original<typeof import("@/lib/server/auth")>()), authenticated: fixture.auth,
}));
import { GET, POST } from "@/app/api/meals/route";
import { DELETE } from "@/app/api/meals/[id]/route";

if (!process.env.FIRESTORE_EMULATOR_HOST ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST))
  throw new Error("Requires local Firestore emulator; refuses live project access");

// Separate emulator project: these tests must not erase the quota/meal suites.
const app = initializeApp({ projectId: "demo-kcalcue-photo-meal" }, "photo-meal-emulator-test");
const db = getFirestore(app);
const policy: PhotoQuotaPolicy = {
  uploadsEnabled: true,
  maxPendingPerUid: 5,
  maxReservedBytesPerUid: 10 * MAX_PHOTO_JPEG_BYTES,
  maxReservedBytesProject: 100 * MAX_PHOTO_JPEG_BYTES,
};
const inputHash = "a".repeat(64);
const jpegHash = "b".repeat(64);
function body() {
  return { ...newDraft(), mutationId: crypto.randomUUID(),
    items: createEditableFoodItems(demoFoodAnalysis.foods) };
}
function post(payload: unknown) {
  return POST(new Request("http://localhost/api/meals", {
    method: "POST", body: JSON.stringify(payload),
  }));
}
async function attachable(uid: string, mealId: string) {
  const uploadId = crypto.randomUUID();
  await reservePhotoAsset(db, uid, { mealId, uploadId, inputSha256: inputHash, inputBytes: 1000 }, policy);
  await finalizePhotoAsset(db, uid, uploadId, {
    inputSha256: inputHash, generation: String(Date.now()) + Math.floor(Math.random() * 1000),
    jpegSha256: jpegHash, width: 1200, height: 900, byteSize: 100_000,
  });
  return uploadId;
}
function deleteRequest(id: string, version: number, mutationId: string) {
  return DELETE(new Request(`http://localhost/api/meals/${id}?version=${version}&mutationId=${mutationId}`,
    { method: "DELETE" }), { params: Promise.resolve({ id }) });
}
function asUid(uid: string) {
  fixture.auth.mockResolvedValue({ db, user: { id: uid } });
}
afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});

describe("private meal photo transaction lifecycle", () => {
  it("attaches, preserves on an old-client edit, replaces, removes and keeps schema 4 sticky", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    asUid(uid);
    const first = body();
    const created = (await (await post(first)).json()).record as MealRecord;
    expect(created.schemaVersion).toBe(3);
    expect(created).not.toHaveProperty("photoRef");
    const uploadId = await attachable(uid, first.id);
    const attach = { ...created, mutationId: crypto.randomUUID(),
      photoAction: { kind: "attach", uploadId },
      photoRef: { attachmentId: "client-forgery", generation: "9" } };
    const attached = (await (await post(attach)).json()).record as MealRecord;
    expect(attached.schemaVersion).toBe(4);
    expect(attached.photoRef).toMatchObject({ attachmentId: uploadId, contentType: "image/jpeg", width: 1200 });
    expect((await photoAssetRef(db, uid, uploadId).get()).data()?.state).toBe("attached");
    expect((await db.doc(`${accountPath(uid)}/photoQuota/current`).get()).data()?.pendingCount).toBe(0);
    const beforeRetry = await mealCollection(db, uid).doc(first.id).get();
    expect((await (await post(attach)).json()).record).toEqual(attached);
    expect((await mealCollection(db, uid).doc(first.id).get()).updateTime?.isEqual(beforeRetry.updateTime!)).toBe(true);
    const oldClientEdit = { ...attached, mutationId: crypto.randomUUID(), time: "20:00" };
    delete (oldClientEdit as { photoRef?: unknown }).photoRef;
    const preserved = (await (await post(oldClientEdit)).json()).record as MealRecord;
    expect(preserved.photoRef).toEqual(attached.photoRef);
    const secondId = await attachable(uid, first.id);
    const replaced = (await (await post({ ...preserved, mutationId: crypto.randomUUID(),
      photoAction: { kind: "attach", uploadId: secondId } })).json()).record as MealRecord;
    expect(replaced.photoRef?.attachmentId).toBe(secondId);
    expect((await photoAssetRef(db, uid, uploadId).get()).data()?.state).toBe("deleting");
    expect((await photoAssetRef(db, uid, secondId).get()).data()?.state).toBe("attached");
    const removed = (await (await post({ ...replaced, mutationId: crypto.randomUUID(),
      photoAction: { kind: "remove" } })).json()).record as MealRecord;
    expect(removed.photoRef).toBeNull();
    expect(removed.schemaVersion).toBe(4);
    expect((await photoAssetRef(db, uid, secondId).get()).data()?.state).toBe("deleting");
    const reloaded = (await (await GET(new Request("http://localhost/api/meals"))).json()).records;
    expect(reloaded).toEqual([removed]);
    expect(reloaded[0].analysis).toEqual(created.analysis);
    expect(reloaded[0].createdAt).toBe(created.createdAt);
  });

  it("deletes an attached photo in the meal tombstone transaction and retries without writes", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    asUid(uid);
    const first = body();
    const uploadId = await attachable(uid, first.id);
    const created = (await (await post({ ...first,
      photoAction: { kind: "attach", uploadId } })).json()).record as MealRecord;
    expect(created.photoRef?.attachmentId).toBe(uploadId);
    const mutationId = crypto.randomUUID();
    expect((await deleteRequest(first.id, 1, mutationId)).status).toBe(200);
    const deleted = await mealCollection(db, uid).doc(first.id).get();
    expect(deleted.data()).toEqual({ deleted: true, version: 2, mutationId });
    expect((await photoAssetRef(db, uid, uploadId).get()).data()?.state).toBe("deleting");
    const assetBeforeRetry = await photoAssetRef(db, uid, uploadId).get();
    const revision = (await db.doc(accountPath(uid)).get()).data()?.revision;
    expect((await deleteRequest(first.id, 1, mutationId)).status).toBe(200);
    expect((await photoAssetRef(db, uid, uploadId).get()).updateTime?.isEqual(assetBeforeRetry.updateTime!)).toBe(true);
    expect((await db.doc(accountPath(uid)).get()).data()?.revision).toBe(revision);
  });

  it("rejects cross-meal, cross-owner and expired staged assets without changing a meal", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    asUid(uid);
    const first = body();
    const created = (await (await post(first)).json()).record as MealRecord;
    const otherMeal = await attachable(uid, crypto.randomUUID());
    const otherOwner = `owner-${crypto.randomUUID()}`;
    const otherAsset = await attachable(otherOwner, first.id);
    const expiring = await attachable(uid, first.id);
    await photoAssetRef(db, uid, expiring).update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    for (const uploadId of [otherMeal, otherAsset, expiring]) {
      const response = await post({ ...created, mutationId: crypto.randomUUID(),
        photoAction: { kind: "attach", uploadId } });
      expect(response.status).toBe(409);
    }
    expect((await mealCollection(db, uid).doc(first.id).get()).data()?.record).toEqual(created);
    expect((await photoAssetRef(db, uid, otherMeal).get()).data()?.state).toBe("staged");
    expect((await photoAssetRef(db, otherOwner, otherAsset).get()).data()?.state).toBe("staged");
  });

  it("keeps an unreadable object generation for cleanup without making it attachable", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    asUid(uid);
    const first = body();
    const uploadId = crypto.randomUUID();
    await reservePhotoAsset(db, uid, {
      mealId: first.id, uploadId, inputSha256: inputHash, inputBytes: 1000,
    }, policy);
    const final = await finalizePhotoAsset(db, uid, uploadId, {
      inputSha256: inputHash, generation: "9007199254740993",
      jpegSha256: jpegHash, width: 1200, height: 900, byteSize: 100_000,
    });
    expect(final).toMatchObject({ state: "deleting", generation: "9007199254740993" });
    expect((await photoAssetRef(db, uid, uploadId).get()).data()?.state).toBe("deleting");
    expect((await db.doc(`${accountPath(uid)}/photoQuota/current`).get()).data()).toEqual({
      pendingCount: 0, reservedBytes: MAX_PHOTO_JPEG_BYTES,
    });
    const attempted = await post({ ...first, photoAction: { kind: "attach", uploadId } });
    expect(attempted.status).toBe(409);
    expect((await mealCollection(db, uid).doc(first.id).get()).exists).toBe(false);
  });

  it("fails closed on malformed staged metadata and a corrupt attached registry during removal", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    asUid(uid);
    const first = body();
    const created = (await (await post(first)).json()).record as MealRecord;
    const malformed = await attachable(uid, first.id);
    await photoAssetRef(db, uid, malformed).update({ jpegSha256: "invalid", pipelineVersion: 999 });
    const before = await mealCollection(db, uid).doc(first.id).get();
    const badAttach = await post({ ...created, mutationId: crypto.randomUUID(),
      photoAction: { kind: "attach", uploadId: malformed } });
    expect(badAttach.status).toBe(503);
    expect((await mealCollection(db, uid).doc(first.id).get()).updateTime?.isEqual(before.updateTime!)).toBe(true);
    const unreadable = await attachable(uid, first.id);
    await photoAssetRef(db, uid, unreadable).update({ generation: "9007199254740993" });
    const badGeneration = await post({ ...created, mutationId: crypto.randomUUID(),
      photoAction: { kind: "attach", uploadId: unreadable } });
    expect(badGeneration.status).toBe(503);
    expect((await mealCollection(db, uid).doc(first.id).get()).updateTime?.isEqual(before.updateTime!)).toBe(true);
    const valid = await attachable(uid, first.id);
    const attached = (await (await post({ ...created, mutationId: crypto.randomUUID(),
      photoAction: { kind: "attach", uploadId: valid } })).json()).record as MealRecord;
    await photoAssetRef(db, uid, valid).update({ jpegSha256: "invalid" });
    const beforeRemove = await mealCollection(db, uid).doc(first.id).get();
    const badRemove = await post({ ...attached, mutationId: crypto.randomUUID(),
      photoAction: { kind: "remove" } });
    expect(badRemove.status).toBe(503);
    expect((await mealCollection(db, uid).doc(first.id).get()).updateTime?.isEqual(beforeRemove.updateTime!)).toBe(true);
    expect((await photoAssetRef(db, uid, valid).get()).data()?.state).toBe("attached");
    const badDelete = await deleteRequest(first.id, attached.version, crypto.randomUUID());
    expect(badDelete.status).toBe(503);
    expect((await mealCollection(db, uid).doc(first.id).get()).data()?.deleted).toBe(false);
  });

  it("allows only one competing versioned attach and refuses future-schema rollback deletion", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    asUid(uid);
    const first = body();
    const created = (await (await post(first)).json()).record as MealRecord;
    const a = await attachable(uid, first.id);
    const b = await attachable(uid, first.id);
    const attempts = [a, b].map((uploadId) => ({
      ...created, mutationId: crypto.randomUUID(), photoAction: { kind: "attach", uploadId },
    }));
    const results = await Promise.all(attempts.map((attempt) => post(attempt)));
    const winnerIndex = results.findIndex((response) => response.status === 200);
    expect(winnerIndex).not.toBe(-1);
    const loserIndex = 1 - winnerIndex;
    // The durable lookup claim may temporarily return 503 while the winner is
    // still in flight. After it settles, the same loser mutation must conflict.
    if (results[loserIndex].status === 503)
      expect((await results[loserIndex].json()).error.code).toBe("operation_in_progress");
    else expect(results[loserIndex].status).toBe(409);
    expect((await post(attempts[loserIndex])).status).toBe(409);
    const winner = (await results[winnerIndex].json()).record as MealRecord;
    expect((await photoAssetRef(db, uid, winner.photoRef!.attachmentId).get()).data()?.state).toBe("attached");
    const loser = winner.photoRef!.attachmentId === a ? b : a;
    expect((await photoAssetRef(db, uid, loser).get()).data()?.state).toBe("staged");
    const ref = mealCollection(db, uid).doc(first.id);
    await ref.update({ "record.schemaVersion": 5 });
    const response = await deleteRequest(first.id, winner.version, crypto.randomUUID());
    expect(response.status).toBe(409);
    expect((await photoAssetRef(db, uid, winner.photoRef!.attachmentId).get()).data()?.state).toBe("attached");
    expect((await ref.get()).data()?.deleted).toBe(false);
  });
});
