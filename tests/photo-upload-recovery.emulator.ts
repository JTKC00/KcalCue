import { createHash } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { accountPath } from "@/lib/firebase/admin";
import { mealCollection } from "@/lib/firebase/meals";
import {
  MAX_PHOTO_JPEG_BYTES, expireUnattachedPhotoAsset, finalizePhotoAsset,
  photoAssetRef, photoObjectKey, recordPhotoAssetDeletion, reservePhotoAsset,
} from "@/lib/firebase/photo-assets";
import { recoverReservedPhotoUpload } from "@/lib/firebase/photo-upload-recovery";
import { HttpError } from "@/lib/server/auth";
import type { StoredPhoto } from "@/lib/server/stored-photo";

if (!process.env.FIRESTORE_EMULATOR_HOST ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST))
  throw new Error("Requires local Firestore emulator; refuses live project access");

const app = initializeApp({ projectId: "demo-kcalcue-photo-recovery" }, "photo-recovery-emulator-test");
const db = getFirestore(app);
const policy = {
  uploadsEnabled: true,
  bucketName: "private-recovery-fixture",
  maxPendingPerUid: 5,
  maxReservedBytesPerUid: 10 * MAX_PHOTO_JPEG_BYTES,
  maxReservedBytesProject: 100 * MAX_PHOTO_JPEG_BYTES,
};
const jpeg = new Uint8Array(new ArrayBuffer(4));
jpeg.set([0xff, 0xd8, 0xff, 0xd9]);
const jpegSha256 = createHash("sha256").update(jpeg).digest("hex");
const inputSha256 = "a".repeat(64);
const generation = "9007199254740993";
const expected: StoredPhoto = { jpeg, jpegSha256, inputSha256, width: 640, height: 480, pipelineVersion: 1 };
const request = () => ({ mealId: crypto.randomUUID(), uploadId: crypto.randomUUID(), inputSha256, inputBytes: 1000 });
const owner = () => `owner-${crypto.randomUUID()}`;
const metadata = () => ({ generation, size: jpeg.length, contentType: "image/jpeg" as const,
  inputSha256, jpegSha256, width: 640, height: 480 });
function objects(overrides: Partial<{ metadata: () => Promise<ReturnType<typeof metadata>>;
  read: () => Promise<Uint8Array<ArrayBuffer>> }> = {}) {
  return {
    metadata: vi.fn(overrides.metadata ?? (async () => metadata())),
    read: vi.fn(overrides.read ?? (async () => jpeg)),
  };
}

afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});

describe("unknown-result private photo upload recovery", () => {
  it("stages only the original exact generation after metadata and actual bytes agree", async () => {
    const uid = owner();
    const input = request();
    await reservePhotoAsset(db, uid, input, policy);
    const store = objects();
    const first = await recoverReservedPhotoUpload(db, store, uid, input, expected);
    expect(first.state).toBe("staged");
    expect(first.generation).toBe(generation);
    expect(store.metadata).toHaveBeenCalledWith(policy.bucketName, photoObjectKey(uid, input.mealId, input.uploadId));
    expect(store.read).toHaveBeenCalledWith(policy.bucketName, first.objectKey, generation);
    expect((await db.doc(`${accountPath(uid)}/photoQuota/current`).get()).data()).toEqual({
      pendingCount: 1, reservedBytes: MAX_PHOTO_JPEG_BYTES,
    });
    expect(await recoverReservedPhotoUpload(db, store, uid, input, expected)).toEqual(first);
    expect(store.metadata).toHaveBeenCalledTimes(1);
    expect(store.read).toHaveBeenCalledTimes(1);
  });

  it("keeps quota and uploading state after an unknown Storage result", async () => {
    const uid = owner();
    const input = request();
    await reservePhotoAsset(db, uid, input, policy);
    const store = objects({ metadata: async () => { throw new HttpError(503, "photo_storage_unavailable"); } });
    await expect(recoverReservedPhotoUpload(db, store, uid, input, expected))
      .rejects.toMatchObject({ status: 503, code: "photo_storage_unavailable" });
    expect(store.read).not.toHaveBeenCalled();
    expect((await photoAssetRef(db, uid, input.uploadId).get()).data()?.state).toBe("uploading");
    expect((await db.doc(`${accountPath(uid)}/photoQuota/current`).get()).data()?.reservedBytes)
      .toBe(MAX_PHOTO_JPEG_BYTES);
  });

  it("rejects wrong owner, meal, input, metadata, and forged metadata bytes", async () => {
    const uid = owner();
    const input = request();
    await reservePhotoAsset(db, uid, input, policy);
    const store = objects();
    await expect(recoverReservedPhotoUpload(db, store, owner(), input, expected))
      .rejects.toMatchObject({ status: 404 });
    await expect(recoverReservedPhotoUpload(db, store, uid, { ...input, mealId: crypto.randomUUID() }, expected))
      .rejects.toMatchObject({ status: 409 });
    await expect(recoverReservedPhotoUpload(db, store, uid, { ...input, inputSha256: "b".repeat(64) }, expected))
      .rejects.toMatchObject({ status: 409 });
    await expect(recoverReservedPhotoUpload(db, store, uid, input, { ...expected, jpegSha256: "c".repeat(64) }))
      .rejects.toMatchObject({ status: 409 });
    expect(store.metadata).not.toHaveBeenCalled();
    const mismatchedMetadata = objects({ metadata: async () => ({ ...metadata(), jpegSha256: "b".repeat(64) }) });
    await expect(recoverReservedPhotoUpload(db, mismatchedMetadata, uid, input, expected))
      .rejects.toMatchObject({ status: 409, code: "photo_object_conflict" });
    expect(mismatchedMetadata.read).not.toHaveBeenCalled();
    const forgedBytes = objects({ read: async () => new Uint8Array([0xff, 0xd8, 0xff, 0x00]) });
    await expect(recoverReservedPhotoUpload(db, forgedBytes, uid, input, expected))
      .rejects.toMatchObject({ status: 409, code: "photo_object_conflict" });
    expect((await photoAssetRef(db, uid, input.uploadId).get()).data()?.state).toBe("uploading");
  });

  it("never returns attachable state if expiry wins between metadata and finalize", async () => {
    const uid = owner();
    const input = request();
    await reservePhotoAsset(db, uid, input, policy);
    const ref = photoAssetRef(db, uid, input.uploadId);
    const store = objects({ read: async () => {
      await ref.update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
      await expireUnattachedPhotoAsset(db, uid, input.uploadId);
      return jpeg;
    } });
    const result = await recoverReservedPhotoUpload(db, store, uid, input, expected);
    expect(result.state).toBe("deleting");
    expect(result.generation).toBe(generation);
    expect((await db.doc(`${accountPath(uid)}/photoQuota/current`).get()).data()).toEqual({
      pendingCount: 0, reservedBytes: MAX_PHOTO_JPEG_BYTES,
    });
    const noFurtherReads = objects();
    expect((await recoverReservedPhotoUpload(db, noFurtherReads, uid, input, expected)).state).toBe("deleting");
    expect(noFurtherReads.metadata).not.toHaveBeenCalled();
  });

  it("never stages a photo if the meal is deleted during the exact-generation read", async () => {
    const uid = owner();
    const input = request();
    await reservePhotoAsset(db, uid, input, policy);
    const store = objects({ read: async () => {
      await mealCollection(db, uid).doc(input.mealId).set({ deleted: true, version: 1 });
      return jpeg;
    } });
    const result = await recoverReservedPhotoUpload(db, store, uid, input, expected);
    expect(result.state).toBe("deleting");
    expect(result.generation).toBe(generation);
    expect((await db.doc(`${accountPath(uid)}/photoQuota/current`).get()).data()).toEqual({
      pendingCount: 0, reservedBytes: MAX_PHOTO_JPEG_BYTES,
    });
  });

  it("recovers a late object after an absence tombstone without making it attachable", async () => {
    const uid = owner();
    const input = request();
    await reservePhotoAsset(db, uid, input, policy);
    const ref = photoAssetRef(db, uid, input.uploadId);
    await ref.update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    await expireUnattachedPhotoAsset(db, uid, input.uploadId);
    await recordPhotoAssetDeletion(db, uid, input.uploadId, {
      kind: "object_absent", bucketName: policy.bucketName,
    });
    expect((await db.doc(`${accountPath(uid)}/photoQuota/current`).get()).data()?.reservedBytes).toBe(0);
    const result = await recoverReservedPhotoUpload(db, objects(), uid, input, expected);
    expect(result.state).toBe("deleting");
    expect(result.generation).toBe(generation);
    expect((await db.doc(`${accountPath(uid)}/photoQuota/current`).get()).data()).toEqual({
      pendingCount: 0, reservedBytes: MAX_PHOTO_JPEG_BYTES,
    });
  });

  it("does not restage an already finalized upload with a different generation", async () => {
    const uid = owner();
    const input = request();
    await reservePhotoAsset(db, uid, input, policy);
    await finalizePhotoAsset(db, uid, input.uploadId, {
      bucketName: policy.bucketName, inputSha256, generation: "9007199254740994",
      jpegSha256, width: 640, height: 480, byteSize: jpeg.length,
    });
    const store = objects();
    expect((await recoverReservedPhotoUpload(db, store, uid, input, expected)).generation)
      .toBe("9007199254740994");
    expect(store.metadata).not.toHaveBeenCalled();
  });

  it("does not replace a generation that another finalizer commits during recovery", async () => {
    const uid = owner();
    const input = request();
    await reservePhotoAsset(db, uid, input, policy);
    const winner = "9007199254740994";
    const store = objects({ read: async () => {
      await finalizePhotoAsset(db, uid, input.uploadId, {
        bucketName: policy.bucketName, inputSha256, generation: winner,
        jpegSha256, width: 640, height: 480, byteSize: jpeg.length,
      });
      return jpeg;
    } });
    await expect(recoverReservedPhotoUpload(db, store, uid, input, expected))
      .rejects.toMatchObject({ status: 409, code: "photo_object_conflict" });
    expect((await photoAssetRef(db, uid, input.uploadId).get()).data())
      .toMatchObject({ state: "staged", generation: winner });
  });
});
