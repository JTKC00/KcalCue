import type { Firestore } from "firebase-admin/firestore";
import { FieldPath, Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import {
  CURRENT_MEAL_SCHEMA_VERSION, photoRefSchema,
  type MealRecord, type PhotoAction, type PhotoRef,
} from "@/lib/meals/types";
import { accountPath } from "./admin";
import { HttpError } from "@/lib/server/auth";
import {
  PHOTO_SCHEMA_VERSION, PHOTO_PIPELINE_VERSION,
  MAX_PHOTO_INPUT_BYTES, MAX_PHOTO_JPEG_BYTES,
  isPersistablePhotoGeneration, isValidPhotoBucketName, photoAssetRef, photoObjectKey,
  photoQuotaRefs, readPhotoQuota, type PhotoAsset,
} from "./photo-assets";

const createdAtSchema = z.iso.datetime();
const sha256Pattern = /^[a-f0-9]{64}$/;

function validAssetMetadata(data: FirebaseFirestore.DocumentData) {
  return isValidPhotoBucketName(data.bucketName) &&
    data.pipelineVersion === PHOTO_PIPELINE_VERSION &&
    data.reservedBytes === MAX_PHOTO_JPEG_BYTES &&
    Number.isInteger(data.inputBytes) && data.inputBytes >= 1 &&
    data.inputBytes <= MAX_PHOTO_INPUT_BYTES &&
    typeof data.inputSha256 === "string" && sha256Pattern.test(data.inputSha256) &&
    typeof data.jpegSha256 === "string" && sha256Pattern.test(data.jpegSha256) &&
    data.createdAt instanceof Timestamp && data.updatedAt instanceof Timestamp &&
    data.expiresAt instanceof Timestamp;
}

export function assertWritableMealSchema(
  record: { schemaVersion?: unknown; photoRef?: unknown } | undefined,
) {
  const version = record?.schemaVersion;
  if (version === PHOTO_SCHEMA_VERSION) {
    // A version-4 meal must retain this explicit field after removal. It is
    // the rollback floor for writers that understand the photo lifecycle.
    if (!record || !("photoRef" in record) ||
        record.photoRef !== null &&
        !photoRefSchema.safeParse(record.photoRef).success)
      throw new HttpError(409, "unsupported_schema");
    return;
  }
  if (
    version !== undefined &&
    version !== 0 &&
    version !== 1 &&
    version !== 2 &&
    version !== CURRENT_MEAL_SCHEMA_VERSION
  )
    throw new HttpError(409, "unsupported_schema");
  if (record && "photoRef" in record) throw new HttpError(409, "unsupported_schema");
}

export function checkedAttachedPhotoAsset(data: FirebaseFirestore.DocumentData | undefined,
  uid: string, mealId: string, ref: PhotoRef): PhotoAsset {
  if (!data || data.ownerUid !== uid || data.mealId !== mealId ||
      data.uploadId !== ref.attachmentId ||
      data.objectKey !== photoObjectKey(uid, mealId, ref.attachmentId) ||
      data.state !== "attached" || data.generation !== ref.generation ||
      data.width !== ref.width || data.height !== ref.height ||
      data.byteSize !== ref.byteSize || !validAssetMetadata(data))
    throw new HttpError(503, "photo_registry_corrupt");
  return data as PhotoAsset;
}

function stagedPhoto(data: FirebaseFirestore.DocumentData | undefined,
  uid: string, mealId: string, uploadId: string): { asset: PhotoAsset; ref: PhotoRef } {
  if (!data || data.ownerUid !== uid || data.mealId !== mealId ||
      data.uploadId !== uploadId ||
      data.objectKey !== photoObjectKey(uid, mealId, uploadId) ||
      data.state !== "staged" || !(data.expiresAt instanceof Timestamp) ||
      data.expiresAt.toMillis() <= Date.now())
    throw new HttpError(409, "photo_not_staged");
  if (!validAssetMetadata(data)) throw new HttpError(503, "photo_registry_corrupt");
  if (typeof data.generation !== "string" || !isPersistablePhotoGeneration(data.generation))
    throw new HttpError(503, "photo_registry_corrupt");
  const parsed = photoRefSchema.safeParse({
    attachmentId: uploadId,
    generation: data.generation,
    contentType: "image/jpeg",
    width: data.width,
    height: data.height,
    byteSize: data.byteSize,
  });
  if (!parsed.success) throw new HttpError(503, "photo_registry_corrupt");
  return { asset: data as PhotoAsset, ref: parsed.data };
}

export function mealCollection(db: Firestore, uid: string) {
  return db.collection(`${accountPath(uid)}/meals`);
}
export async function listMeals(
  db: Firestore,
  uid: string,
): Promise<MealRecord[]> {
  const snapshot = await mealCollection(db, uid)
    .where("deleted", "==", false)
    .get();
  return snapshot.docs.map((doc) => doc.data().record as MealRecord);
}
// One indexed, deterministic query per paged sync read. A full final page may
// require one empty continuation. Legacy and revisionless reads use listMeals.
export const MEAL_SYNC_PAGE_SIZE = 100;
export async function listMealPage(
  db: Firestore,
  uid: string,
  cursor?: string,
): Promise<{ records: MealRecord[]; nextCursor?: string }> {
  let query = mealCollection(db, uid)
    .where("deleted", "==", false)
    .orderBy(FieldPath.documentId())
    .limit(MEAL_SYNC_PAGE_SIZE);
  if (cursor) query = query.startAfter(cursor);
  const snapshot = await query.get();
  const records = snapshot.docs.map((doc) => doc.data().record as MealRecord);
  const nextCursor = snapshot.size === MEAL_SYNC_PAGE_SIZE
    ? snapshot.docs.at(-1)?.id : undefined;
  return { records, ...(nextCursor ? { nextCursor } : {}) };
}
export async function previousMeal(db: Firestore, uid: string, id: string) {
  const snapshot = await mealCollection(db, uid).doc(id).get();
  return snapshot.data() as
    | {
        deleted: boolean;
        record?: MealRecord;
        version: number;
        mutationId: string;
      }
    | undefined;
}
// The version comparison and write run in one transaction. An uncertain retry
// is acknowledged by mutation ID; tombstones prevent deleted meals resurfacing.
export async function commitMeal(
  db: Firestore,
  uid: string,
  record: Omit<MealRecord, "updatedAt">,
  expected: number,
  photoAction?: PhotoAction,
) {
  // Release gate: this accepts only a previously staged server-owned asset.
  // There is deliberately no upload route or storage writer in this slice;
  // never enable uploads before durable object cleanup is operational.
  const ref = mealCollection(db, uid).doc(record.id);
  return db.runTransaction(async (tx) => {
    const previous = (await tx.get(ref)).data();
    if (previous?.deleted) throw new HttpError(409, "conflict");
    if (previous?.mutationId === record.mutationId)
      return previous.record as MealRecord;
    assertWritableMealSchema(previous?.record);
    if ((previous?.version ?? 0) !== expected)
      throw new HttpError(409, "conflict");
    const oldRef: PhotoRef | null = previous?.record?.photoRef ?? null;
    if (photoAction?.kind === "attach" && oldRef?.attachmentId === photoAction.uploadId)
      throw new HttpError(409, "photo_already_attached");
    const oldAssetRef = oldRef && photoAction ? photoAssetRef(db, uid, oldRef.attachmentId) : null;
    const newAssetRef = photoAction?.kind === "attach"
      ? photoAssetRef(db, uid, photoAction.uploadId) : null;
    const quotas = newAssetRef ? photoQuotaRefs(db, uid) : null;
    // Firestore requires all reads before any write, including the account
    // quota and the replaced asset's durable cleanup state.
    const [oldSnap, newSnap, userQuotaSnap, projectQuotaSnap] = await Promise.all([
      oldAssetRef ? tx.get(oldAssetRef) : Promise.resolve(null),
      newAssetRef ? tx.get(newAssetRef) : Promise.resolve(null),
      quotas ? tx.get(quotas.user) : Promise.resolve(null),
      quotas ? tx.get(quotas.project) : Promise.resolve(null),
    ]);
    const oldAsset = oldRef && oldSnap
      ? checkedAttachedPhotoAsset(oldSnap.data(), uid, record.id, oldRef) : null;
    const staged = photoAction?.kind === "attach" && newSnap
      ? stagedPhoto(newSnap.data(), uid, record.id, photoAction.uploadId) : null;
    let nextPhotoRef: PhotoRef | null = oldRef;
    if (photoAction?.kind === "remove") nextPhotoRef = null;
    if (staged) nextPhotoRef = staged.ref;
    const userQuota = staged ? readPhotoQuota(userQuotaSnap?.data()) : null;
    const projectQuota = staged ? readPhotoQuota(projectQuotaSnap?.data()) : null;
    if (staged && (!userQuota || !projectQuota ||
        userQuota.pendingCount < 1 || projectQuota.pendingCount < 1))
      throw new HttpError(503, "photo_quota_corrupt");
    const now = new Date().toISOString();
    const previousCreatedAt = createdAtSchema.safeParse(
      previous?.record?.createdAt,
    );
    // Only the registry may supply a photo reference; callers cannot smuggle
    // a path, generation, or metadata through a meal record object.
    const { photoRef: _clientPhotoRef, ...mealFields } = record;
    void _clientPhotoRef;
    const saved: MealRecord = {
      ...mealFields,
      schemaVersion: previous?.record?.schemaVersion === PHOTO_SCHEMA_VERSION || nextPhotoRef
        ? PHOTO_SCHEMA_VERSION : CURRENT_MEAL_SCHEMA_VERSION,
      ...(previous?.record?.schemaVersion === PHOTO_SCHEMA_VERSION || nextPhotoRef
        ? { photoRef: nextPhotoRef } : {}),
      // A legacy record's first cloud write cannot be reconstructed from its
      // last edit or client meal date. Only new documents receive a timestamp.
      createdAt: previous
        ? previousCreatedAt.success
          ? previousCreatedAt.data
          : null
        : now,
      updatedAt: now,
    };
    if (oldAsset && oldAssetRef)
      tx.set(oldAssetRef, { ...oldAsset, state: "deleting", updatedAt: Timestamp.now() });
    if (staged && newAssetRef && quotas && userQuota && projectQuota) {
      tx.set(newAssetRef, { ...staged.asset, state: "attached", updatedAt: Timestamp.now() });
      tx.set(quotas.user, { ...userQuota, pendingCount: userQuota.pendingCount - 1 });
      tx.set(quotas.project, { ...projectQuota, pendingCount: projectQuota.pendingCount - 1 });
    }
    tx.set(
      ref,
      JSON.parse(
        JSON.stringify({
          deleted: false,
          version: record.version,
          mutationId: record.mutationId,
          record: saved,
        }),
      ),
    );
    tx.set(db.doc(accountPath(uid)), { revision: crypto.randomUUID() }, { merge: true });
    return saved;
  });
}
export async function deleteMeal(
  db: Firestore,
  uid: string,
  id: string,
  expected: number,
  mutationId: string,
) {
  const ref = mealCollection(db, uid).doc(id);
  await db.runTransaction(async (tx) => {
    const previous = (await tx.get(ref)).data();
    if (previous?.deleted) {
      // Another tab may have deleted the same version with a different
      // mutation ID. The requested end state is already durable; acknowledge
      // it without advancing the account revision again. Keep older versions
      // conflicting so a stale delete cannot bypass an intervening edit.
      if (previous.mutationId === mutationId || previous.version === expected + 1)
        return;
      throw new HttpError(409, "conflict");
    }
    // A version-zero DELETE must not create a tombstone for an ID that was
    // never saved. Only an existing meal can authorize persistent cleanup.
    if (!previous) throw new HttpError(409, "conflict");
    if ((previous?.version ?? 0) !== expected)
      throw new HttpError(409, "conflict");
    // A newer writer may attach resources that this version cannot clean up.
    // Reject its record rather than tombstoning the meal without its lifecycle work.
    assertWritableMealSchema(previous?.record);
    const oldRef: PhotoRef | null = previous?.record?.photoRef ?? null;
    const oldAssetRef = oldRef ? photoAssetRef(db, uid, oldRef.attachmentId) : null;
    const oldSnap = oldAssetRef ? await tx.get(oldAssetRef) : null;
    const oldAsset = oldRef && oldSnap ? checkedAttachedPhotoAsset(oldSnap.data(), uid, id, oldRef) : null;
    if (oldAsset && oldAssetRef)
      tx.set(oldAssetRef, { ...oldAsset, state: "deleting", updatedAt: Timestamp.now() });
    tx.set(ref, { deleted: true, version: expected + 1, mutationId });
    tx.set(db.doc(accountPath(uid)), { revision: crypto.randomUUID() }, { merge: true });
  });
}
