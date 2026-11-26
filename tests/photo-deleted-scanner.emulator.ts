import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import {
  MAX_PHOTO_JPEG_BYTES, expireUnattachedPhotoAsset, finalizePhotoAsset,
  photoAssetRef, photoObjectKey, reservePhotoAsset,
} from "@/lib/firebase/photo-assets";
import { cleanupKnownPhotoGeneration } from "@/lib/firebase/photo-cleanup";
import { runDeletedPhotoReconcileBatch } from "@/lib/firebase/photo-deleted-scanner";
import type { ExactPhotoMetadata } from "@/lib/firebase/photo-object-store";

if (!process.env.FIRESTORE_EMULATOR_HOST ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST))
  throw new Error("Requires local Firestore emulator; refuses live project access");

const policy = {
  uploadsEnabled: true,
  bucketName: "private-deleted-fixture",
  maxPendingPerUid: 5,
  maxReservedBytesPerUid: 10 * MAX_PHOTO_JPEG_BYTES,
  maxReservedBytesProject: 100 * MAX_PHOTO_JPEG_BYTES,
};
const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
const jpegSha256 = createHash("sha256").update(jpeg).digest("hex");

async function withDb(run: (db: Firestore) => Promise<void>) {
  const id = crypto.randomUUID();
  const app = initializeApp({ projectId: `demo-photo-deleted-${id}` }, id);
  const db = getFirestore(app);
  try { await run(db); }
  finally { await db.terminate(); await deleteApp(app); }
}

async function deleted(db: Firestore, uid: string) {
  const input = { mealId: crypto.randomUUID(), uploadId: crypto.randomUUID(),
    inputSha256: "a".repeat(64), inputBytes: 1000 };
  await reservePhotoAsset(db, uid, input, policy);
  await photoAssetRef(db, uid, input.uploadId).update({
    expiresAt: Timestamp.fromMillis(Date.now() - 1000),
  });
  await expireUnattachedPhotoAsset(db, uid, input.uploadId);
  await finalizePhotoAsset(db, uid, input.uploadId, {
    bucketName: policy.bucketName, inputSha256: input.inputSha256,
    generation: "9007199254740993", jpegSha256, width: 2, height: 2,
    byteSize: jpeg.byteLength,
  });
  await cleanupKnownPhotoGeneration(db, {
    deleteGeneration: vi.fn(async () => "deleted" as const),
  }, uid, input.uploadId);
  return input;
}

function objects() {
  return {
    metadata: vi.fn(async (): Promise<ExactPhotoMetadata> => { throw new Error("object not found"); }),
    read: vi.fn(async (): Promise<Uint8Array<ArrayBuffer>> => jpeg),
    deleteGeneration: vi.fn(async () => "deleted" as const),
  };
}

describe("deleted photo tombstone reconciliation", () => {
  it("finds an object created after an earlier scan, deletes its exact generation, and wraps", async () => withDb(async (db) => {
    const uid = "late-after-refund";
    const input = await deleted(db, uid);
    const store = objects();
    const first = await runDeletedPhotoReconcileBatch(db, store, 1);
    expect(first).toMatchObject({ scanned: 1, wrapped: false,
      outcomes: [{ result: "error", code: "service_unavailable" }] });
    expect(store.deleteGeneration).not.toHaveBeenCalled();
    store.metadata.mockResolvedValue({
      generation: "9007199254740994", size: jpeg.byteLength, contentType: "image/jpeg",
      inputSha256: input.inputSha256, jpegSha256, width: 2, height: 2,
    });
    const second = await runDeletedPhotoReconcileBatch(db, store, 1);
    expect(second).toMatchObject({ scanned: 1, wrapped: true,
      outcomes: [{ path: photoAssetRef(db, uid, input.uploadId).path,
        result: "deleted_late_generation" }] });
    expect(store.metadata).toHaveBeenCalledWith(policy.bucketName,
      photoObjectKey(uid, input.mealId, input.uploadId));
    expect(store.read).toHaveBeenCalledWith(policy.bucketName,
      photoObjectKey(uid, input.mealId, input.uploadId), "9007199254740994");
    expect(store.deleteGeneration).toHaveBeenCalledWith(policy.bucketName,
      photoObjectKey(uid, input.mealId, input.uploadId), "9007199254740994");
    expect((await photoAssetRef(db, uid, input.uploadId).get()).data())
      .toMatchObject({ state: "deleted", generation: "9007199254740994" });
    expect((await db.doc(`kcalcueUsers/${uid}/photoQuota/current`).get()).data())
      .toEqual({ pendingCount: 0, reservedBytes: 0 });
  }));

  it("does not delete or mark success when reservation, bytes, or prior generation disagree", async () => withDb(async (db) => {
    const uid = "deleted-mismatch";
    const input = await deleted(db, uid);
    const store = objects();
    const metadata = {
      generation: "9007199254740994", size: jpeg.byteLength, contentType: "image/jpeg" as const,
      inputSha256: input.inputSha256, jpegSha256, width: 2, height: 2,
    };
    store.metadata.mockResolvedValue({ ...metadata, inputSha256: "b".repeat(64) });
    expect((await runDeletedPhotoReconcileBatch(db, store, 1)).outcomes)
      .toMatchObject([{ result: "error", code: "photo_object_conflict" }]);
    store.metadata.mockResolvedValue(metadata);
    store.read.mockResolvedValue(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]));
    expect((await runDeletedPhotoReconcileBatch(db, store, 1)).outcomes)
      .toMatchObject([{ result: "error", code: "photo_object_conflict" }]);
    store.metadata.mockResolvedValue({ ...metadata, generation: "9007199254740993" });
    expect((await runDeletedPhotoReconcileBatch(db, store, 1)).outcomes)
      .toMatchObject([{ result: "error", code: "photo_deleted_generation_present" }]);
    expect(store.deleteGeneration).not.toHaveBeenCalled();
    expect((await photoAssetRef(db, uid, input.uploadId).get()).data())
      .toMatchObject({ state: "deleted", generation: "9007199254740993" });
    expect((await db.doc(`kcalcueUsers/${uid}/photoQuota/current`).get()).data()?.reservedBytes)
      .toBe(0);
  }));

  it("fails closed before object access for a corrupt tombstone reservation", async () => withDb(async (db) => {
    const uid = "corrupt-tombstone";
    const input = await deleted(db, uid);
    await photoAssetRef(db, uid, input.uploadId).update({ reservedBytes: "2" });
    const store = objects();
    expect((await runDeletedPhotoReconcileBatch(db, store, 1)).outcomes)
      .toMatchObject([{ result: "error", code: "photo_registry_corrupt" }]);
    expect(store.metadata).not.toHaveBeenCalled();
    expect(store.read).not.toHaveBeenCalled();
    expect(store.deleteGeneration).not.toHaveBeenCalled();
    expect((await db.doc(`kcalcueUsers/${uid}/photoQuota/current`).get()).data())
      .toEqual({ pendingCount: 0, reservedBytes: 0 });
  }));

  it("does not delete when re-reserving a late object would overflow quota", async () => withDb(async (db) => {
    const uid = "quota-overflow";
    const input = await deleted(db, uid);
    await db.doc(`kcalcueUsers/${uid}/photoQuota/current`).update({
      reservedBytes: Number.MAX_SAFE_INTEGER - 1,
    });
    const store = objects();
    store.metadata.mockResolvedValue({
      generation: "9007199254740994", size: jpeg.byteLength, contentType: "image/jpeg",
      inputSha256: input.inputSha256, jpegSha256, width: 2, height: 2,
    });
    expect((await runDeletedPhotoReconcileBatch(db, store, 1)).outcomes)
      .toMatchObject([{ result: "error", code: "photo_quota_corrupt" }]);
    expect(store.deleteGeneration).not.toHaveBeenCalled();
    expect((await photoAssetRef(db, uid, input.uploadId).get()).data())
      .toMatchObject({ state: "deleted", generation: "9007199254740993" });
  }));

  it("skips foreign paths and rejects corrupt cursors and unbounded batches", async () => withDb(async (db) => {
    const foreign = db.doc(`aaa/foreign/photoAssets/${crypto.randomUUID()}`);
    await foreign.set({ state: "deleted", ownerUid: "other" });
    const store = objects();
    expect((await runDeletedPhotoReconcileBatch(db, store, 1)).outcomes)
      .toEqual([{ path: foreign.path, result: "invalid_path" }]);
    expect(store.metadata).not.toHaveBeenCalled();
    await expect(runDeletedPhotoReconcileBatch(db, store, 11))
      .rejects.toMatchObject({ status: 400, code: "invalid_photo_reconcile_batch" });
    await db.doc("kcalcuePhotoDeletedReconcile/current").set({ lastPath: "../wrong" });
    await expect(runDeletedPhotoReconcileBatch(db, store, 1))
      .rejects.toMatchObject({ status: 503, code: "photo_reconcile_cursor_corrupt" });
  }));
});
