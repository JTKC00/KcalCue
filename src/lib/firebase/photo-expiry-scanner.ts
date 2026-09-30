import type { Firestore } from "firebase-admin/firestore";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { HttpError } from "@/lib/server/auth";
import { expireUnattachedPhotoAsset } from "./photo-assets";

const cursorPath = "kcalcuePhotoExpiry/current";
const assetPath = /^kcalcueUsers\/([^/]+)\/photoAssets\/([0-9a-fA-F-]{36})$/;

interface ExpiryCursor { lastPath: string; lastExpiresAt: Timestamp }

function validCursor(data: FirebaseFirestore.DocumentData | undefined): ExpiryCursor | null {
  if (!data || data.lastPath === null && data.lastExpiresAt === null) return null;
  const segments = typeof data.lastPath === "string" ? data.lastPath.split("/") : [];
  if (typeof data.lastPath !== "string" || data.lastPath.length > 1024 ||
      /[\x00-\x1f]/u.test(data.lastPath) || segments.length < 2 ||
      segments.length % 2 !== 0 || !segments.every(Boolean) ||
      segments.at(-2) !== "photoAssets" ||
      !(data.lastExpiresAt instanceof Timestamp))
    throw new HttpError(503, "photo_expiry_cursor_corrupt");
  return { lastPath: data.lastPath, lastExpiresAt: data.lastExpiresAt };
}

function sameCursor(a: ExpiryCursor | null, b: ExpiryCursor | null) {
  return a === null ? b === null : b !== null && a.lastPath === b.lastPath &&
    a.lastExpiresAt.isEqual(b.lastExpiresAt);
}

export interface PhotoExpiryBatchResult {
  scanned: number;
  wrapped: boolean;
  cursor: string | null;
  outcomes: Array<{ path: string; result: "deleting" | "invalid_path" | "error"; code?: string }>;
}

// The query finds only expired, unattached reservations. Each candidate is
// rechecked by the registry transaction so attach/expiry races are safe.
// This source-only batch has no scheduler and does not delete object bytes.
export async function runPhotoExpiryBatch(
  db: Firestore,
  maxItems = 5,
  now = Timestamp.now(),
): Promise<PhotoExpiryBatchResult> {
  if (!Number.isInteger(maxItems) || maxItems < 1 || maxItems > 10)
    throw new HttpError(400, "invalid_photo_expiry_batch");
  const cursorRef = db.doc(cursorPath);
  const before = validCursor((await cursorRef.get()).data());
  const base = db.collectionGroup("photoAssets")
    .where("state", "in", ["uploading", "staged"])
    .where("expiresAt", "<=", now)
    .orderBy("expiresAt")
    .orderBy(FieldPath.documentId());
  let page = await (before === null ? base :
    base.startAfter(before.lastExpiresAt, before.lastPath)).limit(maxItems).get();
  let wrapped = false;
  if (page.empty && before !== null) {
    page = await base.limit(maxItems).get();
    wrapped = true;
  }
  const last = page.docs.at(-1);
  if (last && !(last.data().expiresAt instanceof Timestamp))
    throw new HttpError(503, "photo_registry_corrupt");
  const next: ExpiryCursor | null = last
    ? { lastPath: last.ref.path, lastExpiresAt: last.data().expiresAt as Timestamp }
    : null;
  await db.runTransaction(async (tx) => {
    const current = validCursor((await tx.get(cursorRef)).data());
    if (!sameCursor(current, before)) throw new HttpError(409, "photo_expiry_cursor_conflict");
    tx.set(cursorRef, { lastPath: next?.lastPath ?? null,
      lastExpiresAt: next?.lastExpiresAt ?? null, updatedAt: Timestamp.now() });
  });
  const outcomes: PhotoExpiryBatchResult["outcomes"] = [];
  for (const doc of page.docs) {
    const match = assetPath.exec(doc.ref.path);
    if (!match) {
      outcomes.push({ path: doc.ref.path, result: "invalid_path" });
      continue;
    }
    try {
      const asset = await expireUnattachedPhotoAsset(db, match[1], match[2], now);
      outcomes.push({ path: doc.ref.path, result: asset.state === "deleting" ? "deleting" : "error",
        ...(asset.state === "deleting" ? {} : { code: "photo_expiry_state_changed" }) });
    } catch (error) {
      outcomes.push({ path: doc.ref.path, result: "error",
        code: error instanceof HttpError ? error.code : "service_unavailable" });
    }
  }
  return { scanned: page.size, wrapped, cursor: next?.lastPath ?? null, outcomes };
}
