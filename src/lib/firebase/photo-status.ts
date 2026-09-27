import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { photoRefSchema } from "@/lib/meals/types";
import { HttpError } from "@/lib/server/auth";
import {
  MAX_PHOTO_JPEG_BYTES, PHOTO_PIPELINE_VERSION, isPersistablePhotoGeneration, isValidPhotoBucketName,
  photoAssetRef, photoObjectKey, type PhotoAssetState, type PhotoReservation,
} from "./photo-assets";

// Registry status only. In particular, `uploading` does not mean the object
// is absent: a conditional write may have succeeded before its ACK was lost.
// The caller must reconcile the fixed key and exact bytes before any retry.
export async function readPhotoRegistryStatus(
  db: Firestore, uid: string, request: PhotoReservation,
): Promise<PhotoAssetState> {
  const ref = photoAssetRef(db, uid, request.uploadId);
  const key = photoObjectKey(uid, request.mealId, request.uploadId);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw new HttpError(404, "photo_upload_not_found");
  const asset = snapshot.data();
  if (asset?.ownerUid !== uid) throw new HttpError(404, "photo_upload_not_found");
  if (asset.mealId !== request.mealId || asset.uploadId !== request.uploadId ||
      asset.inputSha256 !== request.inputSha256 || asset.inputBytes !== request.inputBytes)
    throw new HttpError(409, "photo_upload_conflict");
  if (asset.objectKey !== key || !isValidPhotoBucketName(asset.bucketName) ||
      asset.pipelineVersion !== PHOTO_PIPELINE_VERSION ||
      asset.reservedBytes !== MAX_PHOTO_JPEG_BYTES ||
      !(asset.createdAt instanceof Timestamp) || !(asset.expiresAt instanceof Timestamp) ||
      !(asset.updatedAt instanceof Timestamp) ||
      !["uploading", "staged", "attached", "deleting", "deleted"].includes(asset.state) ||
      (asset.generation !== null &&
        (typeof asset.generation !== "string" || !isPersistablePhotoGeneration(asset.generation))) ||
      ((asset.state === "staged" || asset.state === "attached") &&
        (!photoRefSchema.safeParse({
          attachmentId: request.uploadId, generation: asset.generation,
          contentType: "image/jpeg", width: asset.width, height: asset.height,
          byteSize: asset.byteSize,
        }).success || typeof asset.jpegSha256 !== "string" ||
          !/^[a-f0-9]{64}$/.test(asset.jpegSha256))))
    throw new HttpError(503, "photo_registry_corrupt");
  return asset.state as PhotoAssetState;
}
