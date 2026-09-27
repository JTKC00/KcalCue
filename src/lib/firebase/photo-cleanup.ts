import type { Firestore } from "firebase-admin/firestore";
import { createHash } from "node:crypto";
import { HttpError } from "@/lib/server/auth";
import {
  finalizePhotoAsset, isPersistablePhotoGeneration, isValidPhotoBucketName, MAX_PHOTO_JPEG_BYTES,
  photoAssetRef, photoObjectKey, recordPhotoAssetDeletion, type PhotoAsset,
} from "./photo-assets";
import type { ExactPhotoObjectStore } from "./photo-object-store";

export type PhotoCleanupResult =
  | "not_deleting"
  | "awaiting_generation"
  | "already_deleted"
  | "deleted";

export type DeletedPhotoReconcileResult = "not_deleted" | "already_reconciled" | "deleted_late_generation";

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

// A bounded, per-asset primitive for a future trusted scanner. It never
// decides that a 404 proves absence and never refunds a no-generation upload.
// The caller must schedule/back off retries durably; this is not a runner.
export async function cleanupKnownPhotoGeneration(
  db: Firestore,
  objects: Pick<ExactPhotoObjectStore, "deleteGeneration">,
  uid: string,
  uploadId: string,
): Promise<PhotoCleanupResult> {
  const asset = await checkedAsset(db, uid, uploadId);
  if (asset.state === "deleted") return "already_deleted";
  if (asset.state !== "deleting") return "not_deleting";
  if (asset.generation === null) return "awaiting_generation";
  if (typeof asset.generation !== "string" ||
      !isPersistablePhotoGeneration(asset.generation))
    throw new HttpError(503, "photo_registry_corrupt");
  const result = await objects.deleteGeneration(asset.bucketName, asset.objectKey, asset.generation);
  if (result !== "deleted") throw new HttpError(503, "photo_storage_unavailable");
  await recordPhotoAssetDeletion(db, uid, uploadId, {
    kind: "deleted_generation", bucketName: asset.bucketName,
    generation: asset.generation,
  });
  return "deleted";
}

// A crashed upload can leave a deleting reservation without its generation.
// Recover only a present object whose exact-generation bytes match its
// metadata and immutable reservation. Missing/denied/unknown reads retain the
// durable work item and quota; they never prove absence.
export async function reconcileUnknownPhotoGenerationAndCleanup(
  db: Firestore,
  objects: Pick<ExactPhotoObjectStore, "metadata" | "read" | "deleteGeneration">,
  uid: string,
  uploadId: string,
): Promise<PhotoCleanupResult> {
  const first = await cleanupKnownPhotoGeneration(db, objects, uid, uploadId);
  if (first !== "awaiting_generation") return first;
  const asset = await checkedAsset(db, uid, uploadId);
  if (asset.state === "deleted") return "already_deleted";
  if (asset.state !== "deleting") return "not_deleting";
  if (asset.generation !== null) return cleanupKnownPhotoGeneration(db, objects, uid, uploadId);
  const stored = await objects.metadata(asset.bucketName, asset.objectKey);
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
  return cleanupKnownPhotoGeneration(db, objects, uid, uploadId);
}

// A late object write can complete after a reservation was marked deleted and
// refunded. Revisit durable tombstones even if the original finalizer never
// returned. A missing/denied metadata response is outcome-unknown, not proof
// that this immutable key will stay empty.
export async function reconcileDeletedPhotoAsset(
  db: Firestore,
  objects: Pick<ExactPhotoObjectStore, "metadata" | "read" | "deleteGeneration">,
  uid: string,
  uploadId: string,
): Promise<DeletedPhotoReconcileResult> {
  const asset = await checkedAsset(db, uid, uploadId);
  if (asset.state !== "deleted") return "not_deleted";
  const stored = await objects.metadata(asset.bucketName, asset.objectKey);
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
  const result = await cleanupKnownPhotoGeneration(db, objects, uid, uploadId);
  if (result !== "deleted" && result !== "already_deleted")
    throw new HttpError(503, "photo_cleanup_incomplete");
  return result === "deleted" ? "deleted_late_generation" : "already_reconciled";
}
