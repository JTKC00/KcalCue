import type { Firestore } from "firebase-admin/firestore";
import { HttpError } from "@/lib/server/auth";
import {
  isPersistablePhotoGeneration, isValidPhotoBucketName, photoAssetRef,
  photoObjectKey, recordPhotoAssetDeletion,
} from "./photo-assets";
import type { ExactPhotoObjectStore } from "./photo-object-store";

export type PhotoCleanupResult =
  | "not_deleting"
  | "awaiting_generation"
  | "already_deleted"
  | "deleted";

// A bounded, per-asset primitive for a future trusted scanner. It never
// decides that a 404 proves absence and never refunds a no-generation upload.
// The caller must schedule/back off retries durably; this is not a runner.
export async function cleanupKnownPhotoGeneration(
  db: Firestore,
  objects: Pick<ExactPhotoObjectStore, "deleteGeneration">,
  uid: string,
  uploadId: string,
): Promise<PhotoCleanupResult> {
  const snapshot = await photoAssetRef(db, uid, uploadId).get();
  if (!snapshot.exists) throw new HttpError(404, "photo_upload_not_found");
  const asset = snapshot.data();
  let expectedKey: string;
  try { expectedKey = photoObjectKey(uid, asset?.mealId, uploadId); }
  catch { throw new HttpError(503, "photo_registry_corrupt"); }
  if (!asset || asset.ownerUid !== uid || asset.uploadId !== uploadId ||
      !isValidPhotoBucketName(asset.bucketName) ||
      asset.objectKey !== expectedKey ||
      !["uploading", "staged", "attached", "deleting", "deleted"].includes(asset.state))
    throw new HttpError(503, "photo_registry_corrupt");
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
