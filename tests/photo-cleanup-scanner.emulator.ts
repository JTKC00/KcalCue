import { describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp, type Firestore } from "firebase-admin/firestore";
import {
  MAX_PHOTO_JPEG_BYTES, expireUnattachedPhotoAsset, finalizePhotoAsset,
  photoAssetRef, photoObjectKey, reservePhotoAsset,
} from "@/lib/firebase/photo-assets";
import { runDeletingPhotoCleanupBatch } from "@/lib/firebase/photo-cleanup-scanner";
import type { ExactPhotoMetadata } from "@/lib/firebase/photo-object-store";

if (!process.env.FIRESTORE_EMULATOR_HOST ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST))
  throw new Error("Requires local Firestore emulator; refuses live project access");

const policy = {
  uploadsEnabled: true,
  bucketName: "private-cleanup-fixture",
  maxPendingPerUid: 5,
  maxReservedBytesPerUid: 10 * MAX_PHOTO_JPEG_BYTES,
  maxReservedBytesProject: 100 * MAX_PHOTO_JPEG_BYTES,
};
async function withDb(run: (db: Firestore) => Promise<void>) {
  const id = crypto.randomUUID();
  const app = initializeApp({ projectId: `demo-photo-scan-${id}` }, id);
  const db = getFirestore(app);
  try { await run(db); }
  finally { await db.terminate(); await deleteApp(app); }
}
async function deleting(db: Firestore, uid: string, known: boolean) {
  const input = { mealId: crypto.randomUUID(), uploadId: crypto.randomUUID(),
    inputSha256: "a".repeat(64), inputBytes: 1000 };
  await reservePhotoAsset(db, uid, input, policy);
  await photoAssetRef(db, uid, input.uploadId).update({
    expiresAt: Timestamp.fromMillis(Date.now() - 1000),
  });
  await expireUnattachedPhotoAsset(db, uid, input.uploadId);
  if (known) await finalizePhotoAsset(db, uid, input.uploadId, {
    bucketName: policy.bucketName, inputSha256: input.inputSha256,
    generation: "9007199254740993", jpegSha256: "b".repeat(64),
    width: 640, height: 480, byteSize: 100_000,
  });
  return input;
}
function objects() {
  return {
    metadata: vi.fn(async (): Promise<ExactPhotoMetadata> => { throw new Error("metadata unavailable"); }),
    read: vi.fn(async (): Promise<Uint8Array<ArrayBuffer>> => { throw new Error("read unavailable"); }),
    deleteGeneration: vi.fn(async () => "deleted" as const),
  };
}

describe("bounded private photo cleanup scanner", () => {
  it("checkpoints a poison page and wraps after reaching the end", async () => withDb(async (db) => {
    const poison = await deleting(db, "aa-poison", false);
    const good = await deleting(db, "bb-good", true);
    const store = objects();
    const first = await runDeletingPhotoCleanupBatch(db, store, 1);
    expect(first).toMatchObject({ scanned: 1, wrapped: false,
      outcomes: [{ result: "error", code: "service_unavailable" }] });
    expect(first.cursor).toContain(`/${poison.uploadId}`);
    expect(store.deleteGeneration).not.toHaveBeenCalled();
    const second = await runDeletingPhotoCleanupBatch(db, store, 1); // Same durable cursor, new worker invocation.
    expect(second).toMatchObject({ scanned: 1, wrapped: false,
      outcomes: [{ result: "deleted" }] });
    expect(second.cursor).toContain(`/${good.uploadId}`);
    expect(store.deleteGeneration).toHaveBeenCalledTimes(1);
    const third = await runDeletingPhotoCleanupBatch(db, store, 1);
    expect(third).toMatchObject({ scanned: 1, wrapped: true,
      outcomes: [{ result: "error", code: "service_unavailable" }] });
  }));

  it("recovers a present late object's exact generation before deleting and refunding", async () => withDb(async (db) => {
    const uid = "late-upload";
    const input = await deleting(db, uid, false);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const hash = createHash("sha256").update(jpeg).digest("hex");
    const store = objects();
    store.metadata.mockResolvedValue({
      generation: "9007199254740993", size: jpeg.byteLength, contentType: "image/jpeg",
      inputSha256: input.inputSha256, jpegSha256: hash, width: 2, height: 2,
    });
    store.read.mockResolvedValue(jpeg);
    const result = await runDeletingPhotoCleanupBatch(db, store, 1);
    expect(result.outcomes).toEqual([{ path: photoAssetRef(db, uid, input.uploadId).path,
      result: "deleted" }]);
    expect(store.metadata).toHaveBeenCalledWith(policy.bucketName,
      photoObjectKey(uid, input.mealId, input.uploadId));
    expect(store.read).toHaveBeenCalledWith(policy.bucketName,
      photoObjectKey(uid, input.mealId, input.uploadId), "9007199254740993");
    expect(store.deleteGeneration).toHaveBeenCalledWith(policy.bucketName,
      photoObjectKey(uid, input.mealId, input.uploadId), "9007199254740993");
    expect((await photoAssetRef(db, uid, input.uploadId).get()).data()?.state).toBe("deleted");
    expect((await db.doc(`kcalcueUsers/${uid}/photoQuota/current`).get()).data())
      .toEqual({ pendingCount: 0, reservedBytes: 0 });
  }));

  it("retains cleanup work and quota when a late object's reservation or bytes disagree", async () => withDb(async (db) => {
    const uid = "late-mismatch";
    const input = await deleting(db, uid, false);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const hash = createHash("sha256").update(jpeg).digest("hex");
    const store = objects();
    const metadata = {
      generation: "9007199254740993", size: jpeg.byteLength, contentType: "image/jpeg" as const,
      inputSha256: input.inputSha256, jpegSha256: hash, width: 2, height: 2,
    };
    store.metadata.mockResolvedValue({ ...metadata, inputSha256: "b".repeat(64) });
    expect((await runDeletingPhotoCleanupBatch(db, store, 1)).outcomes)
      .toMatchObject([{ result: "error", code: "photo_object_conflict" }]);
    expect(store.read).not.toHaveBeenCalled();
    store.metadata.mockResolvedValue(metadata);
    store.read.mockResolvedValue(Uint8Array.from([0xff, 0xd8, 0xff, 0x00]));
    expect((await runDeletingPhotoCleanupBatch(db, store, 1)).outcomes)
      .toMatchObject([{ result: "error", code: "photo_object_conflict" }]);
    expect(store.deleteGeneration).not.toHaveBeenCalled();
    expect((await photoAssetRef(db, uid, input.uploadId).get()).data())
      .toMatchObject({ state: "deleting", generation: null });
    expect((await db.doc(`kcalcueUsers/${uid}/photoQuota/current`).get()).data()?.reservedBytes)
      .toBe(MAX_PHOTO_JPEG_BYTES);
  }));

  it("keeps an unknown-generation asset when the exact read fails or another finalize wins", async () => withDb(async (db) => {
    const uid = "late-race";
    const input = await deleting(db, uid, false);
    const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
    const metadata = {
      generation: "9007199254740993", size: jpeg.byteLength, contentType: "image/jpeg" as const,
      inputSha256: input.inputSha256,
      jpegSha256: createHash("sha256").update(jpeg).digest("hex"), width: 2, height: 2,
    };
    const store = objects();
    store.metadata.mockResolvedValue(metadata);
    store.read.mockRejectedValue(new Error("exact read 404"));
    expect((await runDeletingPhotoCleanupBatch(db, store, 1)).outcomes)
      .toMatchObject([{ result: "error", code: "service_unavailable" }]);
    expect((await photoAssetRef(db, uid, input.uploadId).get()).data())
      .toMatchObject({ state: "deleting", generation: null });
    store.read.mockImplementation(async () => {
      await finalizePhotoAsset(db, uid, input.uploadId, {
        bucketName: policy.bucketName, inputSha256: input.inputSha256,
        generation: "9007199254740994", jpegSha256: metadata.jpegSha256,
        width: 2, height: 2, byteSize: jpeg.byteLength,
      });
      return jpeg;
    });
    expect((await runDeletingPhotoCleanupBatch(db, store, 1)).outcomes)
      .toMatchObject([{ result: "error", code: "photo_object_conflict" }]);
    expect(store.deleteGeneration).not.toHaveBeenCalled();
    expect((await photoAssetRef(db, uid, input.uploadId).get()).data())
      .toMatchObject({ state: "deleting", generation: "9007199254740994" });
    expect((await db.doc(`kcalcueUsers/${uid}/photoQuota/current`).get()).data()?.reservedBytes)
      .toBe(MAX_PHOTO_JPEG_BYTES);
  }));

  it("skips a foreign photoAssets path without using its claimed owner, then advances", async () => withDb(async (db) => {
    const foreign = db.doc(`aaa/foreign/photoAssets/${crypto.randomUUID()}`);
    await foreign.set({ state: "deleting", ownerUid: "bb-good" });
    const good = await deleting(db, "bb-good", true);
    const store = objects();
    expect((await runDeletingPhotoCleanupBatch(db, store, 1)).outcomes)
      .toEqual([{ path: foreign.path, result: "invalid_path" }]);
    expect(store.deleteGeneration).not.toHaveBeenCalled();
    expect((await runDeletingPhotoCleanupBatch(db, store, 1)).outcomes)
      .toEqual([{ path: photoAssetRef(db, "bb-good", good.uploadId).path, result: "deleted" }]);
  }));

  it("rejects a corrupt persisted cursor and unbounded batch input", async () => withDb(async (db) => {
    const store = objects();
    await expect(runDeletingPhotoCleanupBatch(db, store, 11))
      .rejects.toMatchObject({ status: 400, code: "invalid_photo_cleanup_batch" });
    await db.doc("kcalcuePhotoCleanup/current").set({ lastPath: "../wrong" });
    await expect(runDeletingPhotoCleanupBatch(db, store, 1))
      .rejects.toMatchObject({ status: 503, code: "photo_cleanup_cursor_corrupt" });
    expect(store.deleteGeneration).not.toHaveBeenCalled();
  }));
});
