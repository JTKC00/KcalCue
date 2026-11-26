import type { Firestore } from "firebase-admin/firestore";
import { photoRefSchema, type PhotoRef } from "@/lib/meals/types";
import { HttpError } from "@/lib/server/auth";
import type { StoredPhoto } from "@/lib/server/stored-photo";
import {
  finalizePhotoAsset,
  reservePhotoAsset,
  type PhotoAsset,
  type PhotoQuotaPolicy,
  type PhotoReservation,
} from "./photo-assets";
import type { ExactPhotoObjectStore } from "./photo-object-store";
import { recoverReservedPhotoUpload } from "./photo-upload-recovery";

export interface PhotoUploadResult {
  asset: PhotoAsset;
  photoRef: PhotoRef;
}

function assertMatchesStored(asset: PhotoAsset, stored: StoredPhoto): PhotoRef {
  if (asset.jpegSha256 !== stored.jpegSha256 ||
      asset.byteSize !== stored.jpeg.byteLength ||
      asset.width !== stored.width ||
      asset.height !== stored.height)
    throw new HttpError(409, "photo_object_conflict");
  const parsed = photoRefSchema.safeParse({
    attachmentId: asset.uploadId,
    generation: asset.generation,
    contentType: "image/jpeg",
    width: asset.width,
    height: asset.height,
    byteSize: asset.byteSize,
  });
  if (!parsed.success) throw new HttpError(503, "photo_registry_corrupt");
  return parsed.data;
}

// Coordinates durable reservation, single conditional object write, exact-generation
// readback, and lost-response recovery for one fixed uploadId. Never generates a
// replacement uploadId or refunds quota on an unknown storage outcome.
export async function uploadPrivateMealPhoto(
  db: Firestore,
  objects: Pick<ExactPhotoObjectStore, "create" | "metadata" | "read">,
  uid: string,
  request: PhotoReservation,
  stored: StoredPhoto,
  policy: PhotoQuotaPolicy,
  signal?: AbortSignal,
): Promise<PhotoUploadResult> {
  if (stored.inputSha256 !== request.inputSha256)
    throw new HttpError(409, "photo_upload_conflict");
  const reserved = await reservePhotoAsset(db, uid, request, policy);
  if (reserved.state === "staged" || reserved.state === "attached") {
    return { asset: reserved, photoRef: assertMatchesStored(reserved, stored) };
  }
  if (reserved.state !== "uploading") {
    throw new HttpError(409, "photo_upload_expired");
  }

  let metadata;
  try {
    metadata = await objects.create(
      reserved.bucketName,
      reserved.objectKey,
      stored.jpeg,
      stored.inputSha256,
      stored.width,
      stored.height,
      signal,
    );
  } catch (error) {
    if (error instanceof HttpError && error.status === 409 && error.code === "photo_object_exists") {
      const recovered = await recoverReservedPhotoUpload(db, objects, uid, request, stored);
      if (recovered.state === "staged" || recovered.state === "attached") {
        return { asset: recovered, photoRef: assertMatchesStored(recovered, stored) };
      }
      throw new HttpError(409, "photo_upload_expired");
    }
    throw error;
  }

  const finalized = await finalizePhotoAsset(db, uid, request.uploadId, {
    bucketName: reserved.bucketName,
    inputSha256: reserved.inputSha256,
    generation: metadata.generation,
    jpegSha256: metadata.jpegSha256,
    width: metadata.width,
    height: metadata.height,
    byteSize: metadata.size,
  });
  if (finalized.state !== "staged" && finalized.state !== "attached") {
    throw new HttpError(409, "photo_upload_expired");
  }
  return { asset: finalized, photoRef: assertMatchesStored(finalized, stored) };
}
