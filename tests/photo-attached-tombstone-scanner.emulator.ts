import { describe, expect, it, vi } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";
import { accountPath } from "@/lib/firebase/admin";
import { createEditableFoodItems } from "@/lib/domain/editable-meal";
import { demoFoodAnalysis } from "@/lib/providers/food-vision/demo";
import { newDraft } from "@/lib/meals/types";
import { commitMeal, mealCollection } from "@/lib/firebase/meals";
import {
  MAX_PHOTO_JPEG_BYTES, finalizePhotoAsset, photoAssetRef, reservePhotoAsset,
} from "@/lib/firebase/photo-assets";
import {
  reconcileAttachedPhotoTombstone, runAttachedPhotoTombstoneBatch,
} from "@/lib/firebase/photo-attached-tombstone-scanner";
import { runDeletingPhotoCleanupBatch } from "@/lib/firebase/photo-cleanup-scanner";

if (!process.env.FIRESTORE_EMULATOR_HOST ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST))
  throw new Error("Requires local Firestore emulator; refuses live project access");

const policy = {
  uploadsEnabled: true,
  bucketName: "private-attached-fixture",
  maxPendingPerUid: 5,
  maxReservedBytesPerUid: 10 * MAX_PHOTO_JPEG_BYTES,
  maxReservedBytesProject: 100 * MAX_PHOTO_JPEG_BYTES,
};
async function withDb(run: (db: Firestore) => Promise<void>) {
  const id = crypto.randomUUID();
  const app = initializeApp({ projectId: `demo-photo-attached-${id}` }, id);
  const db = getFirestore(app);
  try { await run(db); }
  finally { await db.terminate(); await deleteApp(app); }
}
async function attached(db: Firestore, uid: string) {
  const draft = newDraft();
  const uploadId = crypto.randomUUID();
  const generation = "9007199254740993";
  await reservePhotoAsset(db, uid, {
    mealId: draft.id, uploadId, inputSha256: "a".repeat(64), inputBytes: 1000,
  }, policy);
  await finalizePhotoAsset(db, uid, uploadId, {
    bucketName: policy.bucketName, inputSha256: "a".repeat(64),
    generation, jpegSha256: "b".repeat(64), width: 640, height: 480, byteSize: 100_000,
  });
  await commitMeal(db, uid, {
    ...draft, userId: uid, version: 1, mutationId: crypto.randomUUID(),
    items: createEditableFoodItems(demoFoodAnalysis.foods),
  }, 0, { kind: "attach", uploadId });
  return { meal: mealCollection(db, uid).doc(draft.id), asset: photoAssetRef(db, uid, uploadId),
    uploadId, generation };
}

describe("bounded attached photo tombstone reconciliation", () => {
  it("keeps healthy photos and moves only a tombstoned meal's exact asset into existing cleanup", async () => withDb(async (db) => {
    const healthy = await attached(db, "aa-healthy");
    const orphan = await attached(db, "bb-tombstone");
    await orphan.meal.set({ deleted: true, version: 2, mutationId: crypto.randomUUID() });
    const quotaRef = db.doc(`${accountPath("bb-tombstone")}/photoQuota/current`);
    const quotaBefore = (await quotaRef.get()).data();

    const batch = await runAttachedPhotoTombstoneBatch(db, 10);
    expect(batch).toMatchObject({ scanned: 2, wrapped: false,
      outcomes: [{ path: healthy.asset.path, result: "meal_not_deleted" },
        { path: orphan.asset.path, result: "deleting" }] });
    expect((await healthy.asset.get()).data()?.state).toBe("attached");
    expect((await orphan.asset.get()).data()).toMatchObject({ state: "deleting", generation: orphan.generation });
    expect((await quotaRef.get()).data()).toEqual(quotaBefore);

    const objects = {
      metadata: vi.fn(async () => { throw new Error("must not inspect an already known generation"); }),
      read: vi.fn(async () => { throw new Error("must not read an already known generation"); }),
      deleteGeneration: vi.fn(async () => "deleted" as const),
    };
    expect((await runDeletingPhotoCleanupBatch(db, objects, 10)).outcomes)
      .toEqual([{ path: orphan.asset.path, result: "deleted" }]);
    expect(objects.deleteGeneration).toHaveBeenCalledWith(policy.bucketName,
      (await orphan.asset.get()).data()?.objectKey, orphan.generation);
    expect((await quotaRef.get()).data()).toEqual({ pendingCount: 0, reservedBytes: 0 });
  }));

  it("fails closed for missing tombstones and corrupt owner/key metadata without touching quota", async () => withDb(async (db) => {
    const missing = await attached(db, "aa-missing");
    const badOwner = await attached(db, "bb-wrong-owner");
    const badKey = await attached(db, "cc-wrong-key");
    await missing.meal.delete();
    await badOwner.meal.set({ deleted: true, version: 2, mutationId: crypto.randomUUID() });
    await badKey.meal.set({ deleted: true, version: 2, mutationId: crypto.randomUUID() });
    await badOwner.asset.update({ ownerUid: "someone-else" });
    await badKey.asset.update({ objectKey: "meal-photos/v1/wrong/key.jpg" });
    const projectQuota = db.doc("kcalcuePhotoQuota/current");
    const quotaBefore = (await projectQuota.get()).data();

    expect((await runAttachedPhotoTombstoneBatch(db, 10)).outcomes)
      .toMatchObject([{ result: "meal_not_deleted" },
        { result: "error", code: "photo_registry_corrupt" },
        { result: "error", code: "photo_registry_corrupt" }]);
    for (const candidate of [missing, badOwner, badKey])
      expect((await candidate.asset.get()).data()?.state).toBe("attached");
    expect((await projectQuota.get()).data()).toEqual(quotaBefore);
  }));

  it("allows only one concurrent transition of a tombstoned asset", async () => withDb(async (db) => {
    const orphan = await attached(db, "race-owner");
    await orphan.meal.set({ deleted: true, version: 2, mutationId: crypto.randomUUID() });
    const quotaRef = db.doc(`${accountPath("race-owner")}/photoQuota/current`);
    const quotaBefore = (await quotaRef.get()).data();
    const results = await Promise.all([
      reconcileAttachedPhotoTombstone(db, "race-owner", orphan.uploadId),
      reconcileAttachedPhotoTombstone(db, "race-owner", orphan.uploadId),
    ]);
    expect(results.sort()).toEqual(["deleting", "not_attached"]);
    expect((await orphan.asset.get()).data()?.state).toBe("deleting");
    expect((await quotaRef.get()).data()).toEqual(quotaBefore);
  }));

  it("persists a bounded cursor past foreign paths and does not re-mark a prior transition", async () => withDb(async (db) => {
    const foreign = db.doc(`aaa/foreign/photoAssets/${crypto.randomUUID()}`);
    await foreign.set({ state: "attached" });
    const orphan = await attached(db, "bb-valid");
    await orphan.meal.set({ deleted: true, version: 2, mutationId: crypto.randomUUID() });
    expect((await runAttachedPhotoTombstoneBatch(db, 1)).outcomes)
      .toEqual([{ path: foreign.path, result: "invalid_path" }]);
    expect((await runAttachedPhotoTombstoneBatch(db, 1)).outcomes)
      .toEqual([{ path: orphan.asset.path, result: "deleting" }]);
    const after = await orphan.asset.get();
    expect(await reconcileAttachedPhotoTombstone(db, "bb-valid", orphan.uploadId)).toBe("not_attached");
    expect((await orphan.asset.get()).updateTime?.isEqual(after.updateTime!)).toBe(true);
    const wrap = await runAttachedPhotoTombstoneBatch(db, 1);
    expect(wrap).toMatchObject({ scanned: 1, wrapped: true,
      outcomes: [{ path: foreign.path, result: "invalid_path" }] });
    await expect(runAttachedPhotoTombstoneBatch(db, 11))
      .rejects.toMatchObject({ status: 400, code: "invalid_photo_tombstone_batch" });
    await db.doc("kcalcuePhotoAttachedTombstones/current").set({ lastPath: "wrong" });
    await expect(runAttachedPhotoTombstoneBatch(db, 1))
      .rejects.toMatchObject({ status: 503, code: "photo_tombstone_cursor_corrupt" });
  }));
});
