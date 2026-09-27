import type { Firestore } from "firebase-admin/firestore";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { HttpError } from "@/lib/server/auth";
import type { ExactPhotoObjectStore } from "./photo-object-store";
import { reconcileDeletedPhotoAsset, type DeletedPhotoReconcileResult } from "./photo-cleanup";

const cursorPath = "kcalcuePhotoDeletedReconcile/current";
const assetPath = /^kcalcueUsers\/([^/]+)\/photoAssets\/([0-9a-fA-F-]{36})$/;

function validCursorPath(path: unknown): path is string {
  if (typeof path !== "string" || path.length > 1024 || /[\x00-\x1f]/u.test(path)) return false;
  const segments = path.split("/");
  return segments.length >= 2 && segments.length % 2 === 0 && segments.every(Boolean) &&
    segments[segments.length - 2] === "photoAssets";
}

export interface DeletedPhotoReconcileBatchResult {
  scanned: number;
  wrapped: boolean;
  cursor: string | null;
  outcomes: Array<{ path: string; result: DeletedPhotoReconcileResult | "invalid_path" | "error"; code?: string }>;
}

// Source-only: a trusted runner must call this repeatedly. Deleted tombstones
// stay in the index, so the cursor wraps and can find a write that arrives
// after an earlier scan. Metadata 404/denied never proves permanent absence.
export async function runDeletedPhotoReconcileBatch(
  db: Firestore,
  objects: Pick<ExactPhotoObjectStore, "metadata" | "read" | "deleteGeneration">,
  maxItems = 5,
): Promise<DeletedPhotoReconcileBatchResult> {
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 10)
    throw new HttpError(400, "invalid_photo_reconcile_batch");
  const cursorRef = db.doc(cursorPath);
  const before = await cursorRef.get();
  const previous = before.data()?.lastPath ?? null;
  if (previous !== null && !validCursorPath(previous))
    throw new HttpError(503, "photo_reconcile_cursor_corrupt");
  const base = db.collectionGroup("photoAssets")
    .where("state", "==", "deleted")
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
      throw new HttpError(409, "photo_reconcile_cursor_conflict");
    tx.set(cursorRef, { lastPath: next, updatedAt: Timestamp.now() });
  });
  const outcomes: DeletedPhotoReconcileBatchResult["outcomes"] = [];
  for (const doc of page.docs) {
    const match = assetPath.exec(doc.ref.path);
    if (!match) {
      outcomes.push({ path: doc.ref.path, result: "invalid_path" });
      continue;
    }
    try {
      const result = await reconcileDeletedPhotoAsset(db, objects, match[1], match[2]);
      outcomes.push({ path: doc.ref.path, result });
    } catch (error) {
      outcomes.push({ path: doc.ref.path, result: "error",
        code: error instanceof HttpError ? error.code : "service_unavailable" });
    }
  }
  return { scanned: page.size, wrapped, cursor: next, outcomes };
}
