import type { Firestore } from "firebase-admin/firestore";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { HttpError } from "@/lib/server/auth";
import type { ExactPhotoObjectStore } from "./photo-object-store";
import { cleanupKnownPhotoGeneration, type PhotoCleanupResult } from "./photo-cleanup";

const cursorPath = "kcalcuePhotoCleanup/current";
const assetPath = /^kcalcueUsers\/([^/]+)\/photoAssets\/([0-9a-fA-F-]{36})$/;

function validCursorPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > 1024 || /[\x00-\x1f]/u.test(path)) return false;
  const segments = path.split("/");
  return segments.length >= 2 && segments.length % 2 === 0 && segments.every(Boolean) &&
    segments[segments.length - 2] === "photoAssets";
}

export interface PhotoCleanupBatchResult {
  scanned: number;
  wrapped: boolean;
  cursor: string | null;
  outcomes: Array<{ path: string; result: PhotoCleanupResult | "invalid_path" | "error"; code?: string }>;
}

// This scans deleting assets only; a separate expiry pass must transition
// abandoned uploading/staged assets before an operator can run this batch.
// The cursor is checkpointed before object calls. A crash can delay a page,
// but the next end-of-index wrap revisits it; poisoned entries cannot starve
// later assets. The Firestore cursor is server-only and does not start a job.
export async function runDeletingPhotoCleanupBatch(
  db: Firestore,
  objects: Pick<ExactPhotoObjectStore, "deleteGeneration">,
  maxItems = 5,
): Promise<PhotoCleanupBatchResult> {
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 10)
    throw new HttpError(400, "invalid_photo_cleanup_batch");
  const cursorRef = db.doc(cursorPath);
  const before = await cursorRef.get();
  const previous = before.data()?.lastPath ?? null;
  if (previous !== null && !validCursorPath(previous))
    throw new HttpError(503, "photo_cleanup_cursor_corrupt");
  const base = db.collectionGroup("photoAssets")
    .where("state", "==", "deleting")
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
      throw new HttpError(409, "photo_cleanup_cursor_conflict");
    tx.set(cursorRef, { lastPath: next, updatedAt: Timestamp.now() });
  });
  const outcomes: PhotoCleanupBatchResult["outcomes"] = [];
  for (const doc of page.docs) {
    const match = assetPath.exec(doc.ref.path);
    if (!match) {
      outcomes.push({ path: doc.ref.path, result: "invalid_path" });
      continue;
    }
    try {
      const result = await cleanupKnownPhotoGeneration(db, objects, match[1], match[2]);
      outcomes.push({ path: doc.ref.path, result });
    } catch (error) {
      outcomes.push({ path: doc.ref.path, result: "error",
        code: error instanceof HttpError ? error.code : "service_unavailable" });
    }
  }
  return { scanned: page.size, wrapped, cursor: next, outcomes };
}
