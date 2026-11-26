import type { Firestore } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { HttpError } from "@/lib/server/auth";
import {
  finalizePhotoAsset, isPersistablePhotoGeneration, isValidPhotoBucketName, MAX_PHOTO_JPEG_BYTES,
  photoAssetRef, photoObjectKey, recordPhotoAssetDeletion, type PhotoAsset,
} from "./photo-assets";
import type { ExactPhotoObjectStore, PhotoBucketIdentity } from "./photo-object-store";

export type PhotoCleanupResult =
  | "not_deleting"
  | "awaiting_generation"
  | "already_deleted"
  | "deleted";

export type DeletedPhotoReconcileResult =
  | "not_deleted"
  | "already_reconciled"
  | "confirmed_absent"
  | "deleted_late_generation";

export interface PhotoAbsenceProofOptions {
  absenceProof?: PhotoBucketIdentity;
  absenceGraceMs?: number;
  nowMs?: number;
}

const DEFAULT_ABSENCE_GRACE_MS = 5 * 60_000;

async function checkedAsset(db: Firestore, uid: string, uploadId: string): Promise<PhotoAsset> {
  const snapshot = await photoAssetRef(db, uid, uploadId).get();
  if (!snapshot.exists) throw new HttpError(404, "photo_upload_not_found");
  const asset = snapshot.data();
  let expectedKey: string;
  try { expectedKey = photoObjectKey(uid, asset?.mealId, uploadId); }
  catch { throw new HttpError(503, "photo_registry_corrupt"); }
  if (!asset || asset.ownerUid !== uid || asset.uploadId !== uploadId ||
      !isValidPhotoBucketName(asset.bucketName) ||
      asset.reservedBytes !== MAX_PHOTO_JPEG_BYTES ||
      asset.objectKey !== expectedKey ||
      !["uploading", "staged", "attached", "deleting", "deleted"].includes(asset.state))
    throw new HttpError(503, "photo_registry_corrupt");
  return asset as PhotoAsset;
}

// A bounded, per-asset primitive for a trusted scanner. It only refunds quota
// on 404/unknown DELETE when a bucket-bound GCS absence proof succeeds.
export async function cleanupKnownPhotoGeneration(
  db: Firestore,
  objects: Pick<ExactPhotoObjectStore, "deleteGeneration"> &
    Partial<Pick<ExactPhotoObjectStore, "verifyGenerationAbsent">>,
  uid: string,
  uploadId: string,
  options?: { absenceProof?: PhotoBucketIdentity },
): Promise<PhotoCleanupResult> {
  const asset = await checkedAsset(db, uid, uploadId);
  if (asset.state === "deleted") return "already_deleted";
  if (asset.state !== "deleting") return "not_deleting";
  if (asset.generation === null) return "awaiting_generation";
  if (typeof asset.generation !== "string" ||
      !isPersistablePhotoGeneration(asset.generation))
    throw new HttpError(503, "photo_registry_corrupt");
  try {
    const result = await objects.deleteGeneration(asset.bucketName, asset.objectKey, asset.generation);
    if (result !== "deleted") throw new HttpError(503, "photo_storage_unavailable");
  } catch (error) {
    if (error instanceof HttpError &&
        error.status === 503 &&
        error.code === "photo_storage_unavailable" &&
        options?.absenceProof &&
        options.absenceProof.bucketName === asset.bucketName &&
        objects.verifyGenerationAbsent) {
      const absent = await objects.verifyGenerationAbsent(
        asset.bucketName, asset.objectKey, asset.generation, options.absenceProof,
      );
      if (absent !== "absent") throw new HttpError(503, "photo_storage_unavailable");
    } else {
      throw error;
    }
  }
  await recordPhotoAssetDeletion(db, uid, uploadId, {
    kind: "deleted_generation", bucketName: asset.bucketName,
    generation: asset.generation,
  });
  return "deleted";
}

// A crashed upload can leave a deleting reservation without its generation.
// Recover only a present object whose exact-generation bytes match its
// metadata and immutable reservation. If the reservation is past the absence
// grace window and bucket-bound listing proves no object exists for the key,
// mark the asset deleted and refund quota.
export async function reconcileUnknownPhotoGenerationAndCleanup(
  db: Firestore,
  objects: Pick<ExactPhotoObjectStore, "metadata" | "read" | "deleteGeneration"> &
    Partial<Pick<ExactPhotoObjectStore, "verifyGenerationAbsent" | "verifyKeyAbsent">>,
  uid: string,
  uploadId: string,
  options?: PhotoAbsenceProofOptions,
): Promise<PhotoCleanupResult> {
  const first = await cleanupKnownPhotoGeneration(db, objects, uid, uploadId, options);
  if (first !== "awaiting_generation") return first;
  const asset = await checkedAsset(db, uid, uploadId);
  if (asset.state === "deleted") return "already_deleted";
  if (asset.state !== "deleting") return "not_deleting";
  if (asset.generation !== null)
    return cleanupKnownPhotoGeneration(db, objects, uid, uploadId, options);
  let stored;
  try {
    stored = await objects.metadata(asset.bucketName, asset.objectKey);
  } catch (error) {
    const graceMs = options?.absenceGraceMs ?? DEFAULT_ABSENCE_GRACE_MS;
    const nowMs = options?.nowMs ?? Date.now();
    if (error instanceof HttpError &&
        error.status === 503 &&
        error.code === "photo_storage_unavailable" &&
        options?.absenceProof &&
        options.absenceProof.bucketName === asset.bucketName &&
        objects.verifyKeyAbsent &&
        asset.expiresAt.toMillis() + graceMs <= nowMs) {
      const absent = await objects.verifyKeyAbsent(
        asset.bucketName, asset.objectKey, options.absenceProof,
      );
      if (absent !== "absent") throw new HttpError(503, "photo_storage_unavailable");
      await recordPhotoAssetDeletion(db, uid, uploadId, {
        kind: "object_absent", bucketName: asset.bucketName,
      });
      return "deleted";
    }
    throw error;
  }
  if (stored.inputSha256 !== asset.inputSha256)
    throw new HttpError(409, "photo_object_conflict");
  const bytes = await objects.read(asset.bucketName, asset.objectKey, stored.generation);
  if (bytes.byteLength !== stored.size || bytes.byteLength < 3 ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff ||
      createHash("sha256").update(bytes).digest("hex") !== stored.jpegSha256)
    throw new HttpError(409, "photo_object_conflict");
  await finalizePhotoAsset(db, uid, uploadId, {
    bucketName: asset.bucketName,
    inputSha256: stored.inputSha256,
    generation: stored.generation,
    jpegSha256: stored.jpegSha256,
    width: stored.width,
    height: stored.height,
    byteSize: stored.size,
  });
  return cleanupKnownPhotoGeneration(db, objects, uid, uploadId, options);
}

// A late object write can complete after a reservation was marked deleted and
// refunded. Revisit durable tombstones even if the original finalizer never
// returned. A missing/denied metadata response is outcome-unknown, not proof
// that this immutable key will stay empty.
export async function reconcileDeletedPhotoAsset(
  db: Firestore,
  objects: Pick<ExactPhotoObjectStore, "metadata" | "read" | "deleteGeneration"> &
    Partial<Pick<ExactPhotoObjectStore, "verifyGenerationAbsent" | "verifyKeyAbsent">>,
  uid: string,
  uploadId: string,
  options?: { absenceProof?: PhotoBucketIdentity },
): Promise<DeletedPhotoReconcileResult> {
  const asset = await checkedAsset(db, uid, uploadId);
  if (asset.state !== "deleted") return "not_deleted";
  let stored;
  try {
    stored = await objects.metadata(asset.bucketName, asset.objectKey);
  } catch (error) {
    if (error instanceof HttpError &&
        error.status === 503 &&
        error.code === "photo_storage_unavailable" &&
        options?.absenceProof &&
        options.absenceProof.bucketName === asset.bucketName &&
        objects.verifyKeyAbsent) {
      const absent = await objects.verifyKeyAbsent(
        asset.bucketName, asset.objectKey, options.absenceProof,
      );
      if (absent !== "absent") throw new HttpError(503, "photo_storage_unavailable");
      return "confirmed_absent";
    }
    throw error;
  }
  if (stored.generation === asset.generation)
    throw new HttpError(503, "photo_deleted_generation_present");
  if (stored.inputSha256 !== asset.inputSha256)
    throw new HttpError(409, "photo_object_conflict");
  const bytes = await objects.read(asset.bucketName, asset.objectKey, stored.generation);
  if (bytes.byteLength !== stored.size || bytes.byteLength < 3 ||
      bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff ||
      createHash("sha256").update(bytes).digest("hex") !== stored.jpegSha256)
    throw new HttpError(409, "photo_object_conflict");
  const finalized = await finalizePhotoAsset(db, uid, uploadId, {
    bucketName: asset.bucketName,
    inputSha256: stored.inputSha256,
    generation: stored.generation,
    jpegSha256: stored.jpegSha256,
    width: stored.width,
    height: stored.height,
    byteSize: stored.size,
  });
  if (finalized.state === "deleted" && finalized.generation === stored.generation)
    return "already_reconciled";
  if (finalized.state !== "deleting" || finalized.generation !== stored.generation)
    throw new HttpError(409, "photo_object_conflict");
  const result = await cleanupKnownPhotoGeneration(db, objects, uid, uploadId, options);
  if (result !== "deleted" && result !== "already_deleted")
    throw new HttpError(503, "photo_cleanup_incomplete");
  return result === "deleted" ? "deleted_late_generation" : "already_reconciled";
}
