import { createHash } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { deleteApp, initializeApp } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { accountPath } from "@/lib/firebase/admin";
import { mealCollection } from "@/lib/firebase/meals";
import {
  MAX_PHOTO_JPEG_BYTES,
  photoAssetRef,
  photoObjectKey,
  reservePhotoAsset,
} from "@/lib/firebase/photo-assets";
import { uploadPrivateMealPhoto } from "@/lib/firebase/photo-upload";
import { HttpError } from "@/lib/server/auth";
import type { StoredPhoto } from "@/lib/server/stored-photo";

if (!process.env.FIRESTORE_EMULATOR_HOST ||
    !/^127\.0\.0\.1:\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST))
  throw new Error("Requires local Firestore emulator; refuses live project access");

const app = initializeApp({ projectId: "demo-kcalcue-photo-upload" }, "photo-upload-emulator-test");
const db = getFirestore(app);
const policy = {
  uploadsEnabled: true,
  bucketName: "private-upload-fixture",
  maxPendingPerUid: 5,
  maxReservedBytesPerUid: 10 * MAX_PHOTO_JPEG_BYTES,
  maxReservedBytesProject: 100 * MAX_PHOTO_JPEG_BYTES,
};
const jpeg = new Uint8Array(new ArrayBuffer(4));
jpeg.set([0xff, 0xd8, 0xff, 0xd9]);
const jpegSha256 = createHash("sha256").update(jpeg).digest("hex");
const inputSha256 = "a".repeat(64);
const exactGeneration = "9007199254740993";
const stored: StoredPhoto = {
  jpeg,
  jpegSha256,
  inputSha256,
  width: 640,
  height: 480,
  pipelineVersion: 1,
};

function request() {
  return {
    mealId: crypto.randomUUID(),
    uploadId: crypto.randomUUID(),
    inputSha256,
    inputBytes: 1024,
  };
}

function makeObjects(overrides: {
  create?: () => Promise<{
    generation: string;
    size: number;
    contentType: "image/jpeg";
    inputSha256: string;
    jpegSha256: string;
    width: number;
    height: number;
  }>;
  metadata?: () => Promise<{
    generation: string;
    size: number;
    contentType: "image/jpeg";
    inputSha256: string;
    jpegSha256: string;
    width: number;
    height: number;
  }>;
  read?: () => Promise<Uint8Array<ArrayBuffer>>;
} = {}) {
  const defaultMeta = () => ({
    generation: exactGeneration,
    size: jpeg.byteLength,
    contentType: "image/jpeg" as const,
    inputSha256,
    jpegSha256,
    width: 640,
    height: 480,
  });
  return {
    create: vi.fn(overrides.create ?? (async () => defaultMeta())),
    metadata: vi.fn(overrides.metadata ?? (async () => defaultMeta())),
    read: vi.fn(overrides.read ?? (async () => jpeg)),
  };
}

afterAll(async () => {
  await db.terminate();
  await deleteApp(app);
});

describe("private meal photo upload flow", () => {
  it("fails closed when uploadsEnabled is false without creating reservations or objects", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    const input = request();
    const objects = makeObjects();
    await expect(
      uploadPrivateMealPhoto(db, objects, uid, input, stored, { ...policy, uploadsEnabled: false }),
    ).rejects.toMatchObject({ status: 503, code: "photo_uploads_disabled" });
    expect(objects.create).not.toHaveBeenCalled();
    expect((await photoAssetRef(db, uid, input.uploadId).get()).exists).toBe(false);
  });

  it("reserves, writes once, stages exact generation, and stays idempotent on same-ID retry", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    const input = request();
    const objects = makeObjects();
    const first = await uploadPrivateMealPhoto(db, objects, uid, input, stored, policy);
    expect(first.asset.state).toBe("staged");
    expect(first.photoRef).toEqual({
      attachmentId: input.uploadId,
      generation: exactGeneration,
      contentType: "image/jpeg",
      width: 640,
      height: 480,
      byteSize: jpeg.byteLength,
    });
    expect(objects.create).toHaveBeenCalledTimes(1);
    expect(objects.create).toHaveBeenCalledWith(
      policy.bucketName,
      photoObjectKey(uid, input.mealId, input.uploadId),
      jpeg,
      inputSha256,
      640,
      480,
      undefined,
    );

    const retry = await uploadPrivateMealPhoto(db, objects, uid, input, stored, policy);
    expect(retry.photoRef).toEqual(first.photoRef);
    expect(objects.create).toHaveBeenCalledTimes(1);
  });

  it("rejects same uploadId with different input bytes without writing a second object", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    const input = request();
    const objects = makeObjects();
    await uploadPrivateMealPhoto(db, objects, uid, input, stored, policy);

    const otherSha = "b".repeat(64);
    await expect(
      uploadPrivateMealPhoto(
        db,
        objects,
        uid,
        { ...input, inputSha256: otherSha },
        { ...stored, inputSha256: otherSha },
        policy,
      ),
    ).rejects.toMatchObject({ status: 409, code: "photo_upload_conflict" });
    expect(objects.create).toHaveBeenCalledTimes(1);
  });

  it("recovers exact generation when create returns 412 photo_object_exists after a lost ACK", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    const input = request();
    const objects = makeObjects({
      create: async () => { throw new HttpError(409, "photo_object_exists"); },
    });
    const recovered = await uploadPrivateMealPhoto(db, objects, uid, input, stored, policy);
    expect(recovered.asset.state).toBe("staged");
    expect(recovered.photoRef.generation).toBe(exactGeneration);
    expect(objects.metadata).toHaveBeenCalledTimes(1);
    expect(objects.read).toHaveBeenCalledTimes(1);
  });

  it("preserves uploading state and quota on unknown create failure without refunding or rotating keys", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    const input = request();
    const objects = makeObjects({
      create: async () => { throw new HttpError(503, "photo_storage_unavailable"); },
    });
    await expect(uploadPrivateMealPhoto(db, objects, uid, input, stored, policy))
      .rejects.toMatchObject({ status: 503, code: "photo_storage_unavailable" });
    expect((await photoAssetRef(db, uid, input.uploadId).get()).data()?.state).toBe("uploading");
    expect((await db.doc(`${accountPath(uid)}/photoQuota/current`).get()).data()).toEqual({
      pendingCount: 1,
      reservedBytes: MAX_PHOTO_JPEG_BYTES,
    });
  });

  it("moves to deleting and rejects attach if meal is deleted or reservation expires mid-upload", async () => {
    const uid = `owner-${crypto.randomUUID()}`;
    const input = request();
    await reservePhotoAsset(db, uid, input, policy);
    const objects = makeObjects({
      create: async () => {
        await mealCollection(db, uid).doc(input.mealId).set({ deleted: true, version: 1 });
        await photoAssetRef(db, uid, input.uploadId).update({
          expiresAt: Timestamp.fromMillis(Date.now() - 1000),
        });
        return {
          generation: exactGeneration,
          size: jpeg.byteLength,
          contentType: "image/jpeg" as const,
          inputSha256,
          jpegSha256,
          width: 640,
          height: 480,
        };
      },
    });
    await expect(uploadPrivateMealPhoto(db, objects, uid, input, stored, policy))
      .rejects.toMatchObject({ status: 409, code: "photo_upload_expired" });
    expect((await photoAssetRef(db, uid, input.uploadId).get()).data()).toMatchObject({
      state: "deleting",
      generation: exactGeneration,
    });
  });
});
