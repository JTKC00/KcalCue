import type { Firestore } from "firebase-admin/firestore";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { photoRefSchema } from "@/lib/meals/types";
import { HttpError } from "@/lib/server/auth";
import { accountPath } from "./admin";
import { checkedAttachedPhotoAsset } from "./meals";
import { photoAssetRef } from "./photo-assets";

const cursorPath = "kcalcuePhotoAttachedTombstones/current";
const assetPath = /^kcalcueUsers\/([^/]+)\/photoAssets\/([0-9a-fA-F-]{36})$/;

function validCursorPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > 1024 || /[\x00-\x1f]/u.test(path)) return false;
  const segments = path.split("/");
  return segments.length >= 2 && segments.length % 2 === 0 && segments.every(Boolean) &&
    segments.at(-2) === "photoAssets";
}

export type AttachedTombstoneResult = "deleting" | "meal_not_deleted" | "not_attached";

// A rollback/old writer can leave an attached asset after its meal was
// tombstoned. Re-read both documents in one transaction before admitting it
// to the existing exact-generation cleanup queue. Never infer deletion from
// an absent meal or a stale collection-group query result.
export async function reconcileAttachedPhotoTombstone(
  db: Firestore, uid: string, uploadId: string,
): Promise<AttachedTombstoneResult> {
  const ref = photoAssetRef(db, uid, uploadId);
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return "not_attached";
    const data = snapshot.data();
    if (data?.state !== "attached") return "not_attached";
    const photoRef = photoRefSchema.safeParse({
      attachmentId: uploadId,
      generation: data.generation,
      contentType: "image/jpeg",
      width: data.width,
      height: data.height,
      byteSize: data.byteSize,
    });
    if (!photoRef.success || typeof data.mealId !== "string")
      throw new HttpError(503, "photo_registry_corrupt");
    try {
      checkedAttachedPhotoAsset(data, uid, data.mealId, photoRef.data);
    } catch {
      throw new HttpError(503, "photo_registry_corrupt");
    }
    const meal = await tx.get(db.doc(`${accountPath(uid)}/meals/${data.mealId}`));
    if (meal.data()?.deleted !== true) return "meal_not_deleted";
    tx.update(ref, { state: "deleting", updatedAt: Timestamp.now() });
    return "deleting";
  });
}

export interface AttachedTombstoneBatchResult {
  scanned: number;
  wrapped: boolean;
  cursor: string | null;
  outcomes: Array<{ path: string; result: AttachedTombstoneResult | "invalid_path" | "error"; code?: string }>;
}

// Source-only bounded pass. An authorized durable runner is still required
// before photo retention can be enabled; this function starts no background job.
export async function runAttachedPhotoTombstoneBatch(
  db: Firestore, maxItems = 5,
): Promise<AttachedTombstoneBatchResult> {
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 10)
    throw new HttpError(400, "invalid_photo_tombstone_batch");
  const cursorRef = db.doc(cursorPath);
  const previous = (await cursorRef.get()).data()?.lastPath ?? null;
  if (previous !== null && !validCursorPath(previous))
    throw new HttpError(503, "photo_tombstone_cursor_corrupt");
  const base = db.collectionGroup("photoAssets")
    .where("state", "==", "attached")
    .orderBy(FieldPath.documentId());
  let page = await (previous === null ? base : base.startAfter(previous)).limit(maxItems).get();
  let wrapped = false;
  if (page.empty && previous !== null) {
    page = await base.limit(maxItems).get();
    wrapped = true;
  }
  const next = page.docs.at(-1)?.ref.path ?? null;
  await db.runTransaction(async (tx) => {
    const current = await tx.get(cursorRef);
    if ((current.data()?.lastPath ?? null) !== previous)
      throw new HttpError(409, "photo_tombstone_cursor_conflict");
    tx.set(cursorRef, { lastPath: next, updatedAt: Timestamp.now() });
  });
  const outcomes: AttachedTombstoneBatchResult["outcomes"] = [];
  for (const doc of page.docs) {
    const match = assetPath.exec(doc.ref.path);
    if (!match) {
      outcomes.push({ path: doc.ref.path, result: "invalid_path" });
      continue;
    }
    try {
      const result = await reconcileAttachedPhotoTombstone(db, match[1], match[2]);
      outcomes.push({ path: doc.ref.path, result });
    } catch (error) {
      outcomes.push({ path: doc.ref.path, result: "error",
        code: error instanceof HttpError ? error.code : "service_unavailable" });
    }
  }
  return { scanned: page.size, wrapped, cursor: next, outcomes };
}
