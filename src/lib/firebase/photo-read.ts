import { createHash } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import type { getStorage } from "firebase-admin/storage";
import { HttpError } from "@/lib/server/auth";
import { photoRefSchema, type PhotoRef } from "@/lib/meals/types";
import { mealCollection, checkedAttachedPhotoAsset } from "./meals";
import { isReadablePhotoGeneration, MAX_PHOTO_JPEG_BYTES, photoAssetRef } from "./photo-assets";

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

// The SDK File is pinned to the registry's exact immutable generation. Never
// ask Storage for the newest generation or serve a public download URL.
export async function readPrivatePhoto(
  storage: ReturnType<typeof getStorage>,
  bucketName: string,
  objectKey: string,
  ref: PhotoRef,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256))
    throw new HttpError(503, "photo_unavailable");
  // The installed Storage SDK converts FileOptions.generation to Number.
  // Refuse values it would round instead of accidentally reading another version.
  // This SDK also omits the generation query when the value is zero.
  if (!isReadablePhotoGeneration(ref.generation))
    throw new HttpError(503, "photo_unavailable");
  const generation = Number(ref.generation);
  const stream = storage.bucket(bucketName).file(objectKey, { generation })
    .createReadStream({ validation: "crc32c" });
  const abort = () => stream.destroy();
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort, { once: true });
  const parts: Buffer[] = [];
  const hash = createHash("sha256");
  let total = 0;
  try {
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_PHOTO_JPEG_BYTES || total > ref.byteSize)
        throw new HttpError(503, "photo_unavailable");
      parts.push(bytes);
      hash.update(bytes);
    }
    if (total !== ref.byteSize || hash.digest("hex") !== expectedSha256)
      throw new HttpError(503, "photo_unavailable");
    const output = new Uint8Array(new ArrayBuffer(total));
    output.set(Buffer.concat(parts, total));
    return output;
  } catch {
    stream.destroy();
    throw new HttpError(503, "photo_unavailable");
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}
