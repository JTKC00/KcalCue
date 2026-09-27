import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { HttpError } from "@/lib/server/auth";
import { photoRefSchema, type PhotoRef } from "@/lib/meals/types";
import { mealCollection, checkedAttachedPhotoAsset } from "./meals";
import { MAX_PHOTO_JPEG_BYTES, photoAssetRef } from "./photo-assets";
import { isExactPhotoGeneration, type ExactPhotoObjectStore } from "./photo-object-store";

export async function attachedPhotoForOwner(db: Firestore, uid: string, mealId: string) {
  const meal = (await mealCollection(db, uid).doc(mealId).get()).data();
  if (!meal || meal.deleted || meal.record?.userId !== uid)
    throw new HttpError(404, "photo_not_found");
  const ref: PhotoRef | null | undefined = meal.record.photoRef;
  if (ref == null) throw new HttpError(404, "photo_not_found");
  if (meal.record.schemaVersion !== 4 || !photoRefSchema.safeParse(ref).success)
    throw new HttpError(503, "photo_unavailable");
  const asset = checkedAttachedPhotoAsset(
    (await photoAssetRef(db, uid, ref.attachmentId).get()).data(), uid, mealId, ref,
  );
  return { asset, ref };
}

// The JSON API adapter pins the immutable generation as a decimal string.
// Never ask Storage for the newest generation or serve a public download URL.
export async function readPrivatePhoto(
  objects: Pick<ExactPhotoObjectStore, "read">,
  bucketName: string,
  objectKey: string,
  ref: PhotoRef,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256))
    throw new HttpError(503, "photo_unavailable");
  if (!photoRefSchema.safeParse(ref).success || !isExactPhotoGeneration(ref.generation))
    throw new HttpError(503, "photo_unavailable");
  if (signal?.aborted) throw new HttpError(503, "photo_unavailable");
  try {
    const bytes = await objects.read(bucketName, objectKey, ref.generation, signal);
    if (signal?.aborted || bytes.byteLength < 1 || bytes.byteLength > MAX_PHOTO_JPEG_BYTES ||
        bytes.byteLength !== ref.byteSize ||
        createHash("sha256").update(bytes).digest("hex") !== expectedSha256)
      throw new HttpError(503, "photo_unavailable");
    const output = new Uint8Array(new ArrayBuffer(bytes.byteLength));
    output.set(bytes);
    return output;
  } catch {
    throw new HttpError(503, "photo_unavailable");
  }
}
