import { afterAll, describe, expect, it, vi } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { accountPath } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/server/auth";
import {
  MAX_PHOTO_JPEG_BYTES, expireUnattachedPhotoAsset, finalizePhotoAsset,
  photoAssetRef, recordPhotoAssetDeletion, reservePhotoAsset,
} from "@/lib/firebase/photo-assets";
import { cleanupKnownPhotoGeneration } from "@/lib/firebase/photo-cleanup";

if (!process.env.FIRESTORE_EMULATOR_HOST ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST))
  throw new Error("Requires local Firestore emulator; refuses live project access");

const app = initializeApp({ projectId: "demo-kcalcue-photo-cleanup" }, "photo-cleanup-emulator-test");
const db = getFirestore(app);
const policy = {
  uploadsEnabled: true,
  bucketName: "original-private-fixture",
  maxPendingPerUid: 5,
  maxReservedBytesPerUid: 10 * MAX_PHOTO_JPEG_BYTES,
  maxReservedBytesProject: 100 * MAX_PHOTO_JPEG_BYTES,
};
const inputSha256 = "a".repeat(64);
const jpegSha256 = "b".repeat(64);
const exact = "9007199254740993";

function request() {
  return { mealId: crypto.randomUUID(), uploadId: crypto.randomUUID(),
    inputSha256, inputBytes: 1000 };
}
async function expiredAsset(uid: string, withGeneration: boolean) {
  const input = request();
  await reservePhotoAsset(db, uid, input, policy);
  const ref = photoAssetRef(db, uid, input.uploadId);
  await ref.update({ expiresAt: Timestamp.fromMillis(Date.now() - 1000) });
  await expireUnattachedPhotoAsset(db, uid, input.uploadId);
  if (withGeneration) await finalizePhotoAsset(db, uid, input.uploadId, {
    bucketName: policy.bucketName, inputSha256, generation: exact,
    jpegSha256, width: 640, height: 480, byteSize: 100_000,
  });
  return { input, ref };
}
function store(result: "deleted" | Error = "deleted") {
  const deleteGeneration = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { deleteGeneration };
}

afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});

describe("known-generation private photo cleanup primitive", () => {
  it("uses the reserved bucket and exact generation, then refunds quota once", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    const { input, ref } = await expiredAsset(uid, true);
    const objects = store();
    expect(await cleanupKnownPhotoGeneration(db, objects, uid, input.uploadId)).toBe("deleted");
    expect(objects.deleteGeneration).toHaveBeenCalledWith(
      policy.bucketName, expect.stringContaining(`/${input.mealId}/${input.uploadId}.jpg`), exact,
    );
    expect((await ref.get()).data()).toMatchObject({ state: "deleted", bucketName: policy.bucketName });
    expect((await db.doc(`${accountPath(uid)}/photoQuota/current`).get()).data()).toEqual({
      pendingCount: 0, reservedBytes: 0,
    });
    expect(await cleanupKnownPhotoGeneration(db, objects, uid, input.uploadId)).toBe("already_deleted");
    expect(objects.deleteGeneration).toHaveBeenCalledTimes(1);
  });

  it("does not delete or refund an upload whose generation is still unknown", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    const { input, ref } = await expiredAsset(uid, false);
    const objects = store();
    expect(await cleanupKnownPhotoGeneration(db, objects, uid, input.uploadId)).toBe("awaiting_generation");
    expect(objects.deleteGeneration).not.toHaveBeenCalled();
    expect((await ref.get()).data()?.state).toBe("deleting");
    expect((await db.doc(`${accountPath(uid)}/photoQuota/current`).get()).data()?.reservedBytes)
      .toBe(MAX_PHOTO_JPEG_BYTES);
  });

  it("retains durable work and quota after 404, generation conflict or timeout", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    const { input, ref } = await expiredAsset(uid, true);
    for (const failure of [new HttpError(503, "photo_storage_unavailable"),
      new HttpError(409, "photo_generation_conflict"), new Error("timeout")]) {
      await expect(cleanupKnownPhotoGeneration(db, store(failure), uid, input.uploadId))
        .rejects.toThrow();
      expect((await ref.get()).data()?.state).toBe("deleting");
      expect((await db.doc(`${accountPath(uid)}/photoQuota/current`).get()).data()?.reservedBytes)
        .toBe(MAX_PHOTO_JPEG_BYTES);
    }
    await expect(recordPhotoAssetDeletion(db, uid, input.uploadId, {
      kind: "deleted_generation", bucketName: "wrong-private-fixture", generation: exact,
    })).rejects.toMatchObject({ status: 409, code: "photo_bucket_conflict" });
  });

  it("refunds quota once when two workers receive delete success concurrently", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    const { input, ref } = await expiredAsset(uid, true);
    const objects = store();
    expect(await Promise.all([
      cleanupKnownPhotoGeneration(db, objects, uid, input.uploadId),
      cleanupKnownPhotoGeneration(db, objects, uid, input.uploadId),
    ])).toEqual(["deleted", "deleted"]);
    expect((await ref.get()).data()?.state).toBe("deleted");
    expect((await db.doc(`${accountPath(uid)}/photoQuota/current`).get()).data()).toEqual({
      pendingCount: 0, reservedBytes: 0,
    });
  });

  it("leaves a durable work item if registry confirmation fails after object deletion", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    const { input, ref } = await expiredAsset(uid, true);
    const quota = db.doc(`${accountPath(uid)}/photoQuota/current`);
    await quota.update({ reservedBytes: 0 }); // Simulate a failed confirmation precondition.
    const objects = store();
    await expect(cleanupKnownPhotoGeneration(db, objects, uid, input.uploadId))
      .rejects.toMatchObject({ status: 503, code: "photo_quota_corrupt" });
    expect(objects.deleteGeneration).toHaveBeenCalledTimes(1);
    expect((await ref.get()).data()?.state).toBe("deleting");
    expect((await quota.get()).data()?.reservedBytes).toBe(0);
  });
});
