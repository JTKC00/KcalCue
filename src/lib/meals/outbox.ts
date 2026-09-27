import type { MealRecord } from "./types";
import { resolveCalorieCorrection } from "./calories";
import { readAnalysisProvenance } from "@/lib/domain/analysis-provenance";
export interface PhotoUploadIntent {
  uploadId: string;
  sha256: string;
  byteSize: number;
  pipelineVersion: number;
  status: "pending" | "staged";
}
export interface PendingMeal {
  id: string;
  kind: "save" | "delete";
  record: MealRecord;
  expectedVersion: number;
  error?: string;
  photoUpload?: PhotoUploadIntent;
}
export interface SyncState {
  remote: MealRecord[];
  jobs: PendingMeal[];
  syncedAt: string | null;
  revision?: string;
}
const empty = (): SyncState => ({ remote: [], jobs: [], syncedAt: null });
const PHOTO_STORE = "photoPayloads";
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
interface PhotoPayload {
  uid: string;
  uploadId: string;
  blob: Blob;
  sha256: string;
  byteSize: number;
}
function storageError(tx: IDBTransaction, request?: IDBRequest) {
  return tx.error ?? request?.error ?? new Error("Local storage failed");
}
function abortWith(tx: IDBTransaction, error: unknown, reject: (error: unknown) => void) {
  try { tx.abort(); } catch { /* The transaction already failed. */ }
  reject(error);
}
async function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    // Open the installed schema. A pinned v1 opener fails with VersionError
    // after a later client adds an object store for atomic photo payloads.
    const request = indexedDB.open("kcalcue-sync");
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("accounts"))
        request.result.createObjectStore("accounts");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
// Upgrade only when a photo is first queued. A tab still holding v1 blocks the
// upgrade, so reject its enqueue instead of writing an account job alone.
async function openForPhoto() {
  const current = await open();
  if (current.objectStoreNames.contains(PHOTO_STORE)) return current;
  const nextVersion = current.version + 1;
  current.close();
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("kcalcue-sync", nextVersion);
    let blocked = false;
    request.onblocked = () => {
      blocked = true;
      reject(new Error("Photo storage upgrade blocked by another tab"));
    };
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PHOTO_STORE)) {
        const store = db.createObjectStore(PHOTO_STORE, { keyPath: ["uid", "uploadId"] });
        store.createIndex("uid", "uid");
      }
    };
    request.onsuccess = () => {
      if (blocked) request.result.close();
      else resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}
function clearPhotoRows(store: IDBObjectStore, uid: string, uploadIds?: string[]) {
  if (uploadIds) {
    for (const uploadId of new Set(uploadIds)) store.delete([uid, uploadId]);
    return;
  }
  // An earlier additive store may lack the index; the compound primary key
  // still lets us clear only this account's rows.
  const cursor = store.indexNames.contains("uid")
    ? store.index("uid").openKeyCursor(IDBKeyRange.only(uid))
    : store.openKeyCursor();
  cursor.onsuccess = () => {
    const row = cursor.result;
    if (row) {
      if (Array.isArray(row.primaryKey) && row.primaryKey[0] === uid)
        store.delete(row.primaryKey);
      row.continue();
    }
  };
}
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value).filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
function sameJobIntent(existing: PendingMeal, proposed: PendingMeal) {
  const a = existing.photoUpload;
  const b = proposed.photoUpload;
  return existing.kind === "save" && proposed.kind === "save"
    && existing.id === proposed.id
    && existing.expectedVersion === proposed.expectedVersion
    && existing.record.id === proposed.record.id
    && stableStringify({ ...existing.record, updatedAt: undefined })
      === stableStringify({ ...proposed.record, updatedAt: undefined })
    && a?.uploadId === b?.uploadId
    && a?.pipelineVersion === b?.pipelineVersion
    && a?.sha256 === b?.sha256
    && a?.byteSize === b?.byteSize;
}
export async function enqueuePhotoMeal(
  uid: string,
  job: Omit<PendingMeal, "photoUpload"> & { photoUpload: Pick<PhotoUploadIntent, "uploadId" | "pipelineVersion"> },
  blob: Blob,
): Promise<SyncState> {
  const { uploadId, pipelineVersion } = job.photoUpload;
  if (!uid || job.kind !== "save" || job.record.userId !== uid
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uploadId)
    || pipelineVersion !== 1
    || blob.type !== "image/jpeg" || blob.size < 1 || blob.size > MAX_PHOTO_BYTES)
    throw new Error("Invalid photo upload intent");
  const digest = await crypto.subtle.digest("SHA-256", await blob.arrayBuffer());
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const photoUpload: PhotoUploadIntent = { uploadId, pipelineVersion, sha256, byteSize: blob.size, status: "pending" };
  const queued: PendingMeal = { ...job, photoUpload };
  const db = await openForPhoto();
  try {
    return await new Promise<SyncState>((resolve, reject) => {
      const tx = db.transaction(["accounts", PHOTO_STORE], "readwrite");
      const accounts = tx.objectStore("accounts");
      const photos = tx.objectStore(PHOTO_STORE);
      const request = accounts.get(uid);
      let value: SyncState;
      request.onsuccess = () => {
        const current: SyncState = request.result ?? empty();
        if (current.remote.some((record) => record.mutationId === job.id)) {
          abortWith(tx, new Error("Mutation already acknowledged"), reject);
          return;
        }
        const existing = current.jobs.find((pending) => pending.id === job.id);
        if (current.jobs.some((pending) => pending.record.id === job.record.id && pending.error)) {
          abortWith(tx, new Error("Conflicting pending meal"), reject);
          return;
        }
        if (existing && !sameJobIntent(existing, queued)) {
          abortWith(tx, new Error("Conflicting photo mutation"), reject);
          return;
        }
        if (current.jobs.some((pending) => pending.id !== job.id && pending.photoUpload?.uploadId === uploadId)) {
          abortWith(tx, new Error("Photo upload ID already queued"), reject);
          return;
        }
        const payloadRequest = photos.get([uid, uploadId]);
        payloadRequest.onsuccess = () => {
          const payload = payloadRequest.result as PhotoPayload | undefined;
          if (existing) {
            if (!payload || payload.sha256 !== sha256 || payload.byteSize !== blob.size) {
              abortWith(tx, new Error("Conflicting photo payload"), reject);
              return;
            }
            value = current;
          } else {
            if (payload) {
              abortWith(tx, new Error("Photo upload ID already exists"), reject);
              return;
            }
            value = { ...current, jobs: [...current.jobs, queued] };
            photos.put({ uid, uploadId, blob, sha256, byteSize: blob.size } satisfies PhotoPayload);
            accounts.put(value, uid);
          }
        };
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(storageError(tx, request));
    });
  } finally {
    db.close();
  }
}
export async function readPhotoPayload(uid: string, uploadId: string): Promise<Blob | null> {
  const db = await open();
  try {
    if (!db.objectStoreNames.contains(PHOTO_STORE)) return null;
    return await new Promise<Blob | null>((resolve, reject) => {
      const tx = db.transaction(PHOTO_STORE, "readonly");
      const request = tx.objectStore(PHOTO_STORE).get([uid, uploadId]);
      let value: Blob | null = null;
      request.onsuccess = () => { value = (request.result as PhotoPayload | undefined)?.blob ?? null; };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(storageError(tx, request));
    });
  } finally {
    db.close();
  }
}
export async function markPhotoUploadStaged(uid: string, uploadId: string): Promise<SyncState> {
  const db = await open();
  try {
    if (!db.objectStoreNames.contains(PHOTO_STORE)) throw new Error("Photo storage unavailable");
    return await new Promise<SyncState>((resolve, reject) => {
      const tx = db.transaction(["accounts", PHOTO_STORE], "readwrite");
      const accounts = tx.objectStore("accounts");
      const request = accounts.get(uid);
      let value: SyncState;
      request.onsuccess = () => {
        const current: SyncState = request.result ?? empty();
        const job = current.jobs.find((pending) => pending.photoUpload?.uploadId === uploadId);
        if (!job?.photoUpload) {
          abortWith(tx, new Error("Photo upload intent missing"), reject);
          return;
        }
        const payloadRequest = tx.objectStore(PHOTO_STORE).get([uid, uploadId]);
        payloadRequest.onsuccess = () => {
          const payload = payloadRequest.result as PhotoPayload | undefined;
          if (!payload || payload.sha256 !== job.photoUpload?.sha256
            || payload.byteSize !== job.photoUpload.byteSize) {
            abortWith(tx, new Error("Photo upload payload missing"), reject);
            return;
          }
          value = { ...current, jobs: current.jobs.map((pending) => pending === job ? {
            ...pending, photoUpload: { ...job.photoUpload!, status: "staged" },
          } : pending) };
          accounts.put(value, uid);
        };
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(storageError(tx, request));
    });
  } finally {
    db.close();
  }
}
export async function changeSyncStateAndClearPhotos(
  uid: string,
  change: (state: SyncState) => SyncState,
  uploadIds: string[],
): Promise<SyncState> {
  const db = await open();
  try {
    const hasPhotos = db.objectStoreNames.contains(PHOTO_STORE);
    if (!hasPhotos && uploadIds.length) throw new Error("Photo storage unavailable");
    return await new Promise<SyncState>((resolve, reject) => {
      const tx = db.transaction(hasPhotos ? ["accounts", PHOTO_STORE] : ["accounts"], "readwrite");
      const accounts = tx.objectStore("accounts");
      const request = accounts.get(uid);
      let value: SyncState;
      request.onsuccess = () => {
        try {
          value = change(request.result ?? empty());
          if (value.jobs.some((pending) => pending.photoUpload && uploadIds.includes(pending.photoUpload.uploadId)))
            throw new Error("Cannot clear a queued photo payload");
          accounts.put(value, uid);
          if (hasPhotos) clearPhotoRows(tx.objectStore(PHOTO_STORE), uid, uploadIds);
        } catch (error) {
          abortWith(tx, error, reject);
        }
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(storageError(tx, request));
    });
  } finally {
    db.close();
  }
}
// One IDB transaction prevents tabs losing each other's queued changes.
export async function changeSyncState(
  uid: string,
  change?: (state: SyncState) => SyncState,
): Promise<SyncState> {
  const db = await open();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction("accounts", change ? "readwrite" : "readonly");
      const store = tx.objectStore("accounts");
      const request = store.get(uid);
      let value: SyncState;
      request.onsuccess = () => {
        try {
          value = request.result ?? empty();
          if (change) {
            value = change(value);
            store.put(value, uid);
          }
        } catch (error) {
          tx.abort();
          reject(error);
        }
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () =>
        reject(tx.error ?? request.error ?? new Error("Local storage failed"));
    });
  } finally {
    db.close();
  }
}
export function visibleMeals(state: SyncState) {
  const remote = new Map(state.remote.map((record) => [record.id, record]));
  const meals = new Map(remote);
  for (const job of state.jobs) {
    if (job.kind === "delete") meals.delete(job.record.id);
    else {
      const confirmed = remote.get(job.record.id);
      const previous = meals.get(job.record.id);
      // An old queued edit may predate the first cloud acknowledgement. Its
      // editable values win, but cannot erase or replace confirmed metadata.
      meals.set(job.record.id, {
        ...job.record,
        // Edits cannot replace the accepted/first-queued analysis baseline.
        analysis: previous ? previous.analysis : job.record.analysis,
        originalItems: previous?.originalItems ?? job.record.originalItems,
        analysisProvenance: previous
          ? previous.analysisProvenance ?? null
          : job.record.analysis ? readAnalysisProvenance(job.record.analysisProvenance, job.record.mode) : null,
        calorieCorrection: resolveCalorieCorrection(job.record.calorieCorrection, job.record.items, previous),
        ...(confirmed ? {
          schemaVersion: confirmed.schemaVersion,
          createdAt: confirmed.createdAt,
          // A queued edit contains editable meal fields, not the server-owned
          // photo reference. Keep the confirmed attachment visible offline.
          ...("photoRef" in confirmed ? { photoRef: confirmed.photoRef } : {}),
        } : {}),
      });
    }
  }
  return [...meals.values()];
}
export async function clearSyncState(uid: string) {
  const db = await open();
  try {
    const hasPhotos = db.objectStoreNames.contains(PHOTO_STORE);
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(hasPhotos ? ["accounts", PHOTO_STORE] : ["accounts"], "readwrite");
      tx.objectStore("accounts").put(empty(), uid);
      if (hasPhotos) clearPhotoRows(tx.objectStore(PHOTO_STORE), uid);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(storageError(tx));
    });
  } finally {
    db.close();
  }
}
