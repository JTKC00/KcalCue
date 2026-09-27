import { Buffer } from "node:buffer";
import type { Firestore } from "firebase-admin/firestore";
import { Timestamp } from "firebase-admin/firestore";
import { z } from "zod";
import { HttpError } from "@/lib/server/auth";
import { accountPath } from "./admin";

// Registry and meal transactions are source-only. Do not expose persistent
// uploads until the private bucket, bounded quota, and durable generation-aware
// cleanup runner have been configured and independently accepted together.
export const PHOTO_SCHEMA_VERSION = 4;
export const PHOTO_PIPELINE_VERSION = 1;
export const PHOTO_STAGING_MS = 24 * 60 * 60 * 1000;
export const MAX_PHOTO_INPUT_BYTES = 10 * 1024 * 1024;
export const MAX_PHOTO_JPEG_BYTES = 2 * 1024 * 1024;

const idSchema = z.uuid();
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const uidSchema = z.string().min(1).max(128).refine(
  (uid) => !/[\/\x00-\x1f]/u.test(uid) && !/^__.*__$/.test(uid),
);
const generationSchema = z.string().regex(/^[0-9]{1,32}$/);

export type PhotoAssetState = "uploading" | "staged" | "attached" | "deleting" | "deleted";
export interface PhotoAsset {
  ownerUid: string;
  mealId: string;
  uploadId: string;
  objectKey: string;
  inputSha256: string;
  inputBytes: number;
  pipelineVersion: typeof PHOTO_PIPELINE_VERSION;
  reservedBytes: number;
  state: PhotoAssetState;
  createdAt: Timestamp;
  expiresAt: Timestamp;
  generation: string | null;
  jpegSha256: string | null;
  width: number | null;
  height: number | null;
  byteSize: number | null;
  updatedAt: Timestamp;
}

export interface PhotoQuotaPolicy {
  // An omitted or false flag keeps all new reservations disabled.
  uploadsEnabled?: boolean;
  maxPendingPerUid: number;
  maxReservedBytesPerUid: number;
  maxReservedBytesProject: number;
}

export interface PhotoReservation {
  mealId: string;
  uploadId: string;
  inputSha256: string;
  inputBytes: number;
}

export interface StoredPhotoMetadata {
  inputSha256: string;
  generation: string;
  jpegSha256: string;
  width: number;
  height: number;
  byteSize: number;
}

function parseOwner(uid: string) {
  if (!uidSchema.safeParse(uid).success) throw new HttpError(400, "invalid_owner");
  return uid;
}

function parseUploadId(uploadId: string) {
  if (!idSchema.safeParse(uploadId).success) throw new HttpError(400, "invalid_upload_id");
  return uploadId;
}

function parseReservation(input: PhotoReservation) {
  const parsed = z.object({
    mealId: idSchema,
    uploadId: idSchema,
    inputSha256: sha256Schema,
    inputBytes: z.number().int().min(1).max(MAX_PHOTO_INPUT_BYTES),
  }).safeParse(input);
  if (!parsed.success) throw new HttpError(400, "invalid_photo_reservation");
  return parsed.data;
}

function parseStoredMetadata(input: StoredPhotoMetadata) {
  const parsed = z.object({
    inputSha256: sha256Schema,
    generation: generationSchema,
    jpegSha256: sha256Schema,
    width: z.number().int().min(1).max(1600),
    height: z.number().int().min(1).max(1600),
    byteSize: z.number().int().min(1).max(MAX_PHOTO_JPEG_BYTES),
  }).safeParse(input);
  if (!parsed.success) throw new HttpError(400, "invalid_photo_metadata");
  return parsed.data;
}

function parsePolicy(policy: PhotoQuotaPolicy) {
  if (!policy.uploadsEnabled) throw new HttpError(503, "photo_uploads_disabled");
  const parsed = z.object({
    maxPendingPerUid: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
    maxReservedBytesPerUid: z.number().int().min(MAX_PHOTO_JPEG_BYTES).max(Number.MAX_SAFE_INTEGER),
    maxReservedBytesProject: z.number().int().min(MAX_PHOTO_JPEG_BYTES).max(Number.MAX_SAFE_INTEGER),
  }).safeParse(policy);
  if (!parsed.success) throw new HttpError(503, "photo_quota_not_configured");
  return parsed.data;
}

export function photoAssetRef(db: Firestore, uid: string, uploadId: string) {
  return db.collection(`${accountPath(parseOwner(uid))}/photoAssets`).doc(parseUploadId(uploadId));
}

export function photoObjectKey(uid: string, mealId: string, uploadId: string) {
  parseOwner(uid);
  if (!idSchema.safeParse(mealId).success) throw new HttpError(400, "invalid_meal_id");
  parseUploadId(uploadId);
  return `meal-photos/v1/${Buffer.from(uid, "utf8").toString("base64url")}/${mealId}/${uploadId}.jpg`;
}

export function photoQuotaRefs(db: Firestore, uid: string) {
  return {
    user: db.doc(`${accountPath(uid)}/photoQuota/current`),
    project: db.doc("kcalcuePhotoQuota/current"),
  };
}

export function readPhotoQuota(data: FirebaseFirestore.DocumentData | undefined) {
  if (!data) return { pendingCount: 0, reservedBytes: 0 };
  const { pendingCount, reservedBytes } = data;
  if (!Number.isSafeInteger(pendingCount) || pendingCount < 0 ||
      !Number.isSafeInteger(reservedBytes) || reservedBytes < 0)
    throw new HttpError(503, "photo_quota_corrupt");
  return { pendingCount, reservedBytes };
}

function storedAsset(data: FirebaseFirestore.DocumentData | undefined): PhotoAsset {
  if (!data || !["uploading", "staged", "attached", "deleting", "deleted"].includes(data.state) ||
      !(data.expiresAt instanceof Timestamp) || !(data.createdAt instanceof Timestamp))
    throw new HttpError(503, "photo_registry_corrupt");
  return data as PhotoAsset;
}

function sameReservation(asset: PhotoAsset, uid: string, input: PhotoReservation) {
  return asset.ownerUid === uid && asset.mealId === input.mealId &&
    asset.uploadId === input.uploadId && asset.inputSha256 === input.inputSha256 &&
    asset.inputBytes === input.inputBytes && asset.pipelineVersion === PHOTO_PIPELINE_VERSION &&
    asset.objectKey === photoObjectKey(uid, input.mealId, input.uploadId);
}

// The reservation is durable before any paid object write. Same-ID retries
// return the original immutable key without extending the 24-hour deadline.
export async function reservePhotoAsset(
  db: Firestore,
  uid: string,
  request: PhotoReservation,
  policy: PhotoQuotaPolicy,
): Promise<PhotoAsset> {
  parseOwner(uid);
  const input = parseReservation(request);
  const limits = parsePolicy(policy);
  const ref = photoAssetRef(db, uid, input.uploadId);
  const mealRef = db.doc(`${accountPath(uid)}/meals/${input.mealId}`);
  const refs = photoQuotaRefs(db, uid);
  return db.runTransaction(async (tx) => {
    const [assetSnap, mealSnap, userSnap, projectSnap] = await Promise.all([
      tx.get(ref), tx.get(mealRef), tx.get(refs.user), tx.get(refs.project),
    ]);
    if (mealSnap.data()?.deleted) throw new HttpError(409, "meal_deleted");
    if (assetSnap.exists) {
      const asset = storedAsset(assetSnap.data());
      if (!sameReservation(asset, uid, input)) throw new HttpError(409, "photo_upload_conflict");
      if (asset.state === "deleting" || asset.state === "deleted" ||
          (asset.state !== "attached" && asset.expiresAt.toMillis() <= Date.now()))
        throw new HttpError(409, "photo_upload_expired");
      return asset;
    }
    const user = readPhotoQuota(userSnap.data());
    const project = readPhotoQuota(projectSnap.data());
    if (user.pendingCount >= limits.maxPendingPerUid ||
        user.reservedBytes + MAX_PHOTO_JPEG_BYTES > limits.maxReservedBytesPerUid ||
        project.reservedBytes + MAX_PHOTO_JPEG_BYTES > limits.maxReservedBytesProject)
      throw new HttpError(429, "photo_quota_exceeded");
    const now = Timestamp.now();
    const asset: PhotoAsset = {
      ownerUid: uid,
      mealId: input.mealId,
      uploadId: input.uploadId,
      objectKey: photoObjectKey(uid, input.mealId, input.uploadId),
      inputSha256: input.inputSha256,
      inputBytes: input.inputBytes,
      pipelineVersion: PHOTO_PIPELINE_VERSION,
      reservedBytes: MAX_PHOTO_JPEG_BYTES,
      state: "uploading",
      createdAt: now,
      expiresAt: Timestamp.fromMillis(now.toMillis() + PHOTO_STAGING_MS),
      generation: null,
      jpegSha256: null,
      width: null,
      height: null,
      byteSize: null,
      updatedAt: now,
    };
    tx.create(ref, asset);
    tx.set(refs.user, {
      pendingCount: user.pendingCount + 1,
      reservedBytes: user.reservedBytes + MAX_PHOTO_JPEG_BYTES,
    });
    tx.set(refs.project, {
      pendingCount: project.pendingCount + 1,
      reservedBytes: project.reservedBytes + MAX_PHOTO_JPEG_BYTES,
    });
    return asset;
  });
}

function sameStoredObject(asset: PhotoAsset, metadata: StoredPhotoMetadata) {
  return asset.generation === metadata.generation &&
    asset.jpegSha256 === metadata.jpegSha256 && asset.width === metadata.width &&
    asset.height === metadata.height && asset.byteSize === metadata.byteSize;
}

// Only call after a generation-conditional object write or metadata HEAD has
// established the exact object generation and canonical JPEG checksum.
export async function finalizePhotoAsset(
  db: Firestore,
  uid: string,
  uploadId: string,
  metadata: StoredPhotoMetadata,
): Promise<PhotoAsset> {
  const input = parseStoredMetadata(metadata);
  const ref = photoAssetRef(db, uid, uploadId);
  const refs = photoQuotaRefs(db, uid);
  return db.runTransaction(async (tx) => {
    const [assetSnap, userSnap, projectSnap] = await Promise.all([
      tx.get(ref), tx.get(refs.user), tx.get(refs.project),
    ]);
    if (!assetSnap.exists) throw new HttpError(409, "photo_upload_not_reserved");
    const asset = storedAsset(assetSnap.data());
    if (asset.ownerUid !== uid || asset.uploadId !== uploadId ||
        asset.inputSha256 !== input.inputSha256)
      throw new HttpError(409, "photo_upload_conflict");
    const mealSnap = await tx.get(db.doc(`${accountPath(uid)}/meals/${asset.mealId}`));
    if (asset.state === "deleted" && asset.generation === input.generation)
      // The exact generation was already confirmed gone. A delayed finalize
      // reply for that write cannot recreate it or consume quota again.
      return asset;
    if (asset.state !== "deleted" && asset.generation !== null && !sameStoredObject(asset, input))
      throw new HttpError(409, "photo_object_conflict");
    if (asset.state === "staged" || asset.state === "attached") {
      if (asset.generation === null) throw new HttpError(503, "photo_registry_corrupt");
      return asset;
    }
    if (asset.state === "deleting" && asset.generation !== null) return asset;
    const expired = asset.state !== "uploading" || mealSnap.data()?.deleted === true ||
      asset.expiresAt.toMillis() <= Date.now();
    const now = Timestamp.now();
    const saved: PhotoAsset = {
      ...asset,
      state: expired ? "deleting" : "staged",
      generation: input.generation,
      jpegSha256: input.jpegSha256,
      width: input.width,
      height: input.height,
      byteSize: input.byteSize,
      updatedAt: now,
    };
    tx.set(ref, saved);
    if (expired && asset.state === "uploading") {
      const user = readPhotoQuota(userSnap.data());
      const project = readPhotoQuota(projectSnap.data());
      if (user.pendingCount < 1 || project.pendingCount < 1)
        throw new HttpError(503, "photo_quota_corrupt");
      tx.set(refs.user, { ...user, pendingCount: user.pendingCount - 1 });
      tx.set(refs.project, { ...project, pendingCount: project.pendingCount - 1 });
    } else if (asset.state === "deleted") {
      // A late object write after confirmed absence must re-enter cleanup.
      // It never becomes attachable, even if the old reservation was refunded.
      // This may temporarily exceed admission quotas if that refund was reused;
      // upload enablement requires a bounded in-flight lease and reconciler.
      const user = readPhotoQuota(userSnap.data());
      const project = readPhotoQuota(projectSnap.data());
      tx.set(refs.user, { ...user, reservedBytes: user.reservedBytes + asset.reservedBytes });
      tx.set(refs.project, { ...project, reservedBytes: project.reservedBytes + asset.reservedBytes });
    }
    return saved;
  });
}

// Cleanup admission for abandoned uploads. It never marks an attached photo
// for deletion; that transition must be atomic with a meal edit/delete.
export async function expireUnattachedPhotoAsset(
  db: Firestore,
  uid: string,
  uploadId: string,
  now = Timestamp.now(),
): Promise<PhotoAsset> {
  const ref = photoAssetRef(db, uid, uploadId);
  const refs = photoQuotaRefs(db, uid);
  return db.runTransaction(async (tx) => {
    const [assetSnap, userSnap, projectSnap] = await Promise.all([
      tx.get(ref), tx.get(refs.user), tx.get(refs.project),
    ]);
    if (!assetSnap.exists) throw new HttpError(404, "photo_upload_not_found");
    const asset = storedAsset(assetSnap.data());
    if (asset.ownerUid !== uid) throw new HttpError(404, "photo_upload_not_found");
    if (asset.state === "attached") throw new HttpError(409, "photo_attached");
    if (asset.state === "deleting" || asset.state === "deleted") return asset;
    if (asset.expiresAt.toMillis() > now.toMillis())
      throw new HttpError(409, "photo_upload_not_expired");
    const user = readPhotoQuota(userSnap.data());
    const project = readPhotoQuota(projectSnap.data());
    if (user.pendingCount < 1 || project.pendingCount < 1)
      throw new HttpError(503, "photo_quota_corrupt");
    const saved: PhotoAsset = { ...asset, state: "deleting", updatedAt: now };
    tx.set(ref, saved);
    tx.set(refs.user, { ...user, pendingCount: user.pendingCount - 1 });
    tx.set(refs.project, { ...project, pendingCount: project.pendingCount - 1 });
    return saved;
  });
}

// Called only after the object adapter has confirmed deletion of this exact
// generation, or confirmed that the reserved key has no object at all. The
// registry tombstone remains so a delayed upload cannot reuse this upload ID.
export async function recordPhotoAssetDeletion(
  db: Firestore,
  uid: string,
  uploadId: string,
  confirmation:
    | { kind: "deleted_generation"; generation: string }
    | { kind: "object_absent" },
): Promise<PhotoAsset> {
  if (confirmation.kind === "deleted_generation" &&
      !generationSchema.safeParse(confirmation.generation).success)
    throw new HttpError(400, "invalid_photo_generation");
  const ref = photoAssetRef(db, uid, uploadId);
  const refs = photoQuotaRefs(db, uid);
  return db.runTransaction(async (tx) => {
    const [assetSnap, userSnap, projectSnap] = await Promise.all([
      tx.get(ref), tx.get(refs.user), tx.get(refs.project),
    ]);
    if (!assetSnap.exists) throw new HttpError(404, "photo_upload_not_found");
    const asset = storedAsset(assetSnap.data());
    if (asset.ownerUid !== uid) throw new HttpError(404, "photo_upload_not_found");
    if (asset.state === "deleted") {
      if (confirmation.kind === "deleted_generation" &&
          asset.generation !== confirmation.generation)
        throw new HttpError(409, "photo_generation_conflict");
      return asset;
    }
    if (asset.state !== "deleting") throw new HttpError(409, "photo_not_deleting");
    if (confirmation.kind === "deleted_generation" &&
        asset.generation !== confirmation.generation)
      throw new HttpError(409, "photo_generation_conflict");
    if (confirmation.kind === "object_absent" && asset.generation !== null)
      throw new HttpError(409, "photo_generation_required");
    const user = readPhotoQuota(userSnap.data());
    const project = readPhotoQuota(projectSnap.data());
    if (user.reservedBytes < asset.reservedBytes ||
        project.reservedBytes < asset.reservedBytes)
      throw new HttpError(503, "photo_quota_corrupt");
    const saved: PhotoAsset = {
      ...asset,
      state: "deleted",
      // Keep immutable upload identity for replay rejection, but drop output
      // metadata after confirmed cleanup.
      jpegSha256: null,
      width: null,
      height: null,
      byteSize: null,
      updatedAt: Timestamp.now(),
    };
    tx.set(ref, saved);
    tx.set(refs.user, { ...user, reservedBytes: user.reservedBytes - asset.reservedBytes });
    tx.set(refs.project, { ...project, reservedBytes: project.reservedBytes - asset.reservedBytes });
    return saved;
  });
}
