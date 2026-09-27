import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { HttpError } from "@/lib/server/auth";
import type { StoredPhoto } from "@/lib/server/stored-photo";
import {
  MAX_PHOTO_JPEG_BYTES, PHOTO_PIPELINE_VERSION, finalizePhotoAsset,
  isValidPhotoBucketName, photoAssetRef, photoObjectKey,
  type PhotoAsset, type PhotoReservation,
} from "./photo-assets";
import type { ExactPhotoObjectStore } from "./photo-object-store";

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

// A lost create response cannot be retried as another paid write. Recover the
// original reservation against the original canonical output, including the
// bytes of the exact Storage generation, before asking Firestore to stage it.
// This source-only primitive does not enable uploads or expose a public route.
export async function recoverReservedPhotoUpload(
  db: Firestore,
  objects: Pick<ExactPhotoObjectStore, "metadata" | "read">,
  uid: string,
  request: PhotoReservation,
  expected: StoredPhoto,
): Promise<PhotoAsset> {
  const ref = photoAssetRef(db, uid, request.uploadId);
  const key = photoObjectKey(uid, request.mealId, request.uploadId);
  const assetSnapshot = await ref.get();
  if (!assetSnapshot.exists) throw new HttpError(404, "photo_upload_not_found");
  const asset = assetSnapshot.data() as PhotoAsset | undefined;
  if (!asset || asset.ownerUid !== uid || asset.mealId !== request.mealId ||
      asset.uploadId !== request.uploadId || asset.objectKey !== key ||
      !isValidPhotoBucketName(asset.bucketName) ||
      asset.inputSha256 !== request.inputSha256 || asset.inputBytes !== request.inputBytes ||
      asset.pipelineVersion !== PHOTO_PIPELINE_VERSION ||
      !(asset.createdAt instanceof Timestamp) || !(asset.expiresAt instanceof Timestamp) ||
      !["uploading", "staged", "attached", "deleting", "deleted"].includes(asset.state))
    throw new HttpError(409, "photo_upload_conflict");
  const jpeg = expected.jpeg;
  if (expected.pipelineVersion !== PHOTO_PIPELINE_VERSION ||
      expected.inputSha256 !== request.inputSha256 ||
      !Number.isInteger(request.inputBytes) || request.inputBytes < 1 ||
      !/^[a-f0-9]{64}$/.test(expected.jpegSha256) ||
      jpeg.byteLength < 3 || jpeg.byteLength > MAX_PHOTO_JPEG_BYTES ||
      jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff ||
      sha256(jpeg) !== expected.jpegSha256 ||
      !Number.isInteger(expected.width) || expected.width < 1 || expected.width > 1600 ||
      !Number.isInteger(expected.height) || expected.height < 1 || expected.height > 1600)
    throw new HttpError(409, "photo_upload_conflict");
  // A deletion tombstone may predate a slow, response-lost POST. Recheck that
  // fixed key even after an absence confirmation/refund so a newly visible
  // generation can re-enter durable cleanup with its quota restored.
  if (asset.state === "deleting" && asset.generation !== null) return asset;
  if (asset.state === "staged" || asset.state === "attached") {
    if (asset.jpegSha256 !== expected.jpegSha256 ||
        asset.byteSize !== jpeg.byteLength ||
        asset.width !== expected.width || asset.height !== expected.height ||
        typeof asset.generation !== "string")
      throw new HttpError(409, "photo_object_conflict");
    return asset;
  }

  // A 404, timeout, or permission failure here remains outcome-unknown. The
  // object adapter maps them to an error, so quota stays reserved and no
  // conditional POST is attempted by this path.
  const stored = await objects.metadata(asset.bucketName, key);
  if (stored.inputSha256 !== asset.inputSha256 ||
      stored.jpegSha256 !== expected.jpegSha256 ||
      stored.size !== jpeg.byteLength ||
      stored.width !== expected.width || stored.height !== expected.height)
    throw new HttpError(409, "photo_object_conflict");
  const actual = await objects.read(asset.bucketName, key, stored.generation);
  if (actual.byteLength !== jpeg.byteLength || sha256(actual) !== expected.jpegSha256)
    throw new HttpError(409, "photo_object_conflict");
  return finalizePhotoAsset(db, uid, request.uploadId, {
    bucketName: asset.bucketName,
    inputSha256: asset.inputSha256,
    generation: stored.generation,
    jpegSha256: stored.jpegSha256,
    width: stored.width,
    height: stored.height,
    byteSize: stored.size,
  });
}
