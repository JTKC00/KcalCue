import { afterAll, describe, expect, it } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { accountPath } from "@/lib/firebase/admin";
import { mealCollection } from "@/lib/firebase/meals";
import {
  MAX_PHOTO_JPEG_BYTES,
  expireUnattachedPhotoAsset,
  finalizePhotoAsset,
  photoAssetRef,
  photoObjectKey,
  recordPhotoAssetDeletion,
  reservePhotoAsset,
  type PhotoQuotaPolicy,
} from "@/lib/firebase/photo-assets";

if (!process.env.FIRESTORE_EMULATOR_HOST ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST))
  throw new Error("Requires local Firestore emulator; refuses live project access");

// A distinct emulator project isolates this file's project-wide quota counter
// from the meal API emulator suite, which clears kcalcueUsers between cases.
const app = initializeApp({ projectId: "demo-kcalcue-photo-assets" }, "photo-assets-emulator-test");
const db = getFirestore(app);
const policy: PhotoQuotaPolicy = {
  uploadsEnabled: true,
  maxPendingPerUid: 5,
  maxReservedBytesPerUid: 10 * MAX_PHOTO_JPEG_BYTES,
  maxReservedBytesProject: 100 * MAX_PHOTO_JPEG_BYTES,
};
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const upload = () => ({ mealId: crypto.randomUUID(), uploadId: crypto.randomUUID(), inputSha256: hashA, inputBytes: 12_345 });
const stored = { inputSha256: hashA, generation: "1234567890123456", jpegSha256: hashB,
  width: 1200, height: 900, byteSize: 123_456 };
const uid = () => `photo-user-${crypto.randomUUID()}`;

afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});

describe("private photo asset registry in Firestore emulator", () => {
  it("stays disabled without explicit policy and rejects invalid input before writing", async () => {
    const owner = uid();
    const request = upload();
    await expect(reservePhotoAsset(db, owner, request, { ...policy, uploadsEnabled: false }))
      .rejects.toMatchObject({ status: 503, code: "photo_uploads_disabled" });
    await expect(reservePhotoAsset(db, owner, request, { ...policy, maxReservedBytesProject: 0 }))
      .rejects.toMatchObject({ status: 503, code: "photo_quota_not_configured" });
    await expect(reservePhotoAsset(db, owner, { ...request, inputSha256: "bad" }, policy))
      .rejects.toMatchObject({ status: 400, code: "invalid_photo_reservation" });
    expect((await photoAssetRef(db, owner, request.uploadId).get()).exists).toBe(false);
  });

  it("reserves one UID-scoped immutable key and quota once across same-ID retries", async () => {
    const owner = uid();
    const request = upload();
    const first = await reservePhotoAsset(db, owner, request, policy);
    const retry = await reservePhotoAsset(db, owner, request, policy);
    expect(retry).toEqual(first);
    expect(first.objectKey).toBe(photoObjectKey(owner, request.mealId, request.uploadId));
    expect(first.objectKey).not.toContain(owner);
    expect(first.state).toBe("uploading");
    expect(first.expiresAt.toMillis() - first.createdAt.toMillis()).toBe(24 * 60 * 60 * 1000);
    expect((await db.doc(`${accountPath(owner)}/photoQuota/current`).get()).data()).toEqual({
      pendingCount: 1, reservedBytes: MAX_PHOTO_JPEG_BYTES,
    });
    await expect(reservePhotoAsset(db, owner, { ...request, inputSha256: hashB }, policy))
      .rejects.toMatchObject({ status: 409, code: "photo_upload_conflict" });
    await expect(reservePhotoAsset(db, owner, { ...request, mealId: crypto.randomUUID() }, policy))
      .rejects.toMatchObject({ status: 409, code: "photo_upload_conflict" });
    const otherOwner = uid();
    const other = await reservePhotoAsset(db, otherOwner, request, policy);
    expect(other.objectKey).not.toBe(first.objectKey);
  });

  it("serializes competing same-ID reservations without double-charging quota", async () => {
    const owner = uid();
    const request = upload();
    const results = await Promise.allSettled([
      reservePhotoAsset(db, owner, request, policy),
      reservePhotoAsset(db, owner, { ...request, inputSha256: hashB }, policy),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)
      .toMatchObject({ status: 409, code: "photo_upload_conflict" });
    expect((await db.doc(`${accountPath(owner)}/photoQuota/current`).get()).data()).toEqual({
      pendingCount: 1, reservedBytes: MAX_PHOTO_JPEG_BYTES,
    });
  });

  it("rejects a tombstoned meal and enforces bounded pending and byte quotas", async () => {
    const owner = uid();
    const request = upload();
    await mealCollection(db, owner).doc(request.mealId).set({ deleted: true, version: 1 });
    await expect(reservePhotoAsset(db, owner, request, policy))
      .rejects.toMatchObject({ status: 409, code: "meal_deleted" });
    const bounded = { ...policy, maxPendingPerUid: 1, maxReservedBytesPerUid: MAX_PHOTO_JPEG_BYTES };
    await reservePhotoAsset(db, owner, upload(), bounded);
    await expect(reservePhotoAsset(db, owner, upload(), bounded))
      .rejects.toMatchObject({ status: 429, code: "photo_quota_exceeded" });
  });

  it("finalizes exact object metadata idempotently and rejects changed bytes or generation", async () => {
    const owner = uid();
    const request = upload();
    await reservePhotoAsset(db, owner, request, policy);
    const first = await finalizePhotoAsset(db, owner, request.uploadId, stored);
    expect(first.state).toBe("staged");
    const ref = photoAssetRef(db, owner, request.uploadId);
    const before = (await ref.get()).updateTime;
    expect(await finalizePhotoAsset(db, owner, request.uploadId, stored)).toEqual(first);
    expect((await ref.get()).updateTime?.isEqual(before!)).toBe(true);
    await expect(finalizePhotoAsset(db, owner, request.uploadId, { ...stored, generation: "999" }))
      .rejects.toMatchObject({ status: 409, code: "photo_object_conflict" });
    await expect(finalizePhotoAsset(db, owner, request.uploadId, { ...stored, inputSha256: hashB }))
      .rejects.toMatchObject({ status: 409, code: "photo_upload_conflict" });
  });

  it("keeps a late upload non-attachable when its target meal is tombstoned", async () => {
    const owner = uid();
    const request = upload();
    await reservePhotoAsset(db, owner, request, policy);
    await mealCollection(db, owner).doc(request.mealId).set({ deleted: true, version: 1 });
    await expect(reservePhotoAsset(db, owner, request, policy))
      .rejects.toMatchObject({ status: 409, code: "meal_deleted" });
    const late = await finalizePhotoAsset(db, owner, request.uploadId, stored);
    expect(late.state).toBe("deleting");
    expect(late.generation).toBe(stored.generation);
  });

  it("expiry wins over late finalize; exact-generation cleanup refunds once and leaves a tombstone", async () => {
    const owner = uid();
    const request = upload();
    await reservePhotoAsset(db, owner, request, policy);
    const ref = photoAssetRef(db, owner, request.uploadId);
    await ref.update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    const expired = await expireUnattachedPhotoAsset(db, owner, request.uploadId);
    expect(expired.state).toBe("deleting");
    expect((await db.doc(`${accountPath(owner)}/photoQuota/current`).get()).data()?.pendingCount).toBe(0);
    const late = await finalizePhotoAsset(db, owner, request.uploadId, stored);
    expect(late.state).toBe("deleting");
    expect(late.generation).toBe(stored.generation);
    await expect(recordPhotoAssetDeletion(db, owner, request.uploadId,
      { kind: "deleted_generation", generation: "999" }))
      .rejects.toMatchObject({ status: 409, code: "photo_generation_conflict" });
    const deleted = await recordPhotoAssetDeletion(db, owner, request.uploadId,
      { kind: "deleted_generation", generation: stored.generation });
    expect(deleted.state).toBe("deleted");
    expect(deleted.jpegSha256).toBeNull();
    expect((await db.doc(`${accountPath(owner)}/photoQuota/current`).get()).data()).toEqual({
      pendingCount: 0, reservedBytes: 0,
    });
    expect(await recordPhotoAssetDeletion(db, owner, request.uploadId,
      { kind: "deleted_generation", generation: stored.generation })).toEqual(deleted);
    const beforeStaleReply = (await ref.get()).updateTime;
    expect(await finalizePhotoAsset(db, owner, request.uploadId, stored)).toEqual(deleted);
    expect((await ref.get()).updateTime?.isEqual(beforeStaleReply!)).toBe(true);
    expect((await db.doc(`${accountPath(owner)}/photoQuota/current`).get()).data()?.reservedBytes)
      .toBe(0);
    await expect(reservePhotoAsset(db, owner, request, policy))
      .rejects.toMatchObject({ status: 409, code: "photo_upload_expired" });
    const newGeneration = await finalizePhotoAsset(db, owner, request.uploadId,
      { ...stored, generation: "1234567890123457" });
    expect(newGeneration.state).toBe("deleting");
    expect(newGeneration.generation).toBe("1234567890123457");
    expect((await db.doc(`${accountPath(owner)}/photoQuota/current`).get()).data()?.reservedBytes)
      .toBe(MAX_PHOTO_JPEG_BYTES);
  });

  it("reopens cleanup if a new object appears after confirmed absence, without making it attachable", async () => {
    const owner = uid();
    const request = upload();
    await reservePhotoAsset(db, owner, request, policy);
    const ref = photoAssetRef(db, owner, request.uploadId);
    await ref.update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
    await expireUnattachedPhotoAsset(db, owner, request.uploadId);
    await recordPhotoAssetDeletion(db, owner, request.uploadId, { kind: "object_absent" });
    const late = await finalizePhotoAsset(db, owner, request.uploadId, stored);
    expect(late.state).toBe("deleting");
    expect(late.generation).toBe(stored.generation);
    expect((await db.doc(`${accountPath(owner)}/photoQuota/current`).get()).data()?.reservedBytes)
      .toBe(MAX_PHOTO_JPEG_BYTES);
  });
});
