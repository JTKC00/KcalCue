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
  removePhoto?: boolean;
  seq?: number;
}

export interface SyncState {
  remote: MealRecord[];
  jobs: PendingMeal[];
  syncedAt: string | null;
  revision?: string;
}

// Call inside the account's IndexedDB write transaction. Another tab can hold
// an older meal object, but must not enqueue a command against an older local
// version or revive a meal already queued for deletion.
export function hasCurrentMealVersion(
  state: SyncState, mealId: string, expectedVersion: number, allowCreate = true,
): boolean {
  if (state.jobs.some((job) => job.record.id === mealId && job.kind === "delete"))
    return false;
  const current = visibleMeals(state).find((meal) => meal.id === mealId);
  return current ? current.version === expectedVersion : allowCreate && expectedVersion === 0;
}

const empty = (): SyncState => ({ remote: [], jobs: [], syncedAt: null });
const PHOTO_STORE = "photoPayloads";
const PHOTO_JOBS_STORE = "photoJobs";
const MAX_PHOTO_BYTES = 2 * 1024 * 1024;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PhotoPayload {
  uid: string;
  uploadId: string;
  bytes?: Uint8Array;
  type?: string;
  blob?: Blob;
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

function mergeJobs(accountJobs: PendingMeal[], photoJobs: PendingMeal[]): PendingMeal[] {
  if (photoJobs.length === 0) return accountJobs;
  return [...accountJobs, ...photoJobs].sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1));
}

function splitJobs(jobs: PendingMeal[]): { accountJobs: PendingMeal[]; photoJobs: PendingMeal[] } {
  const photoMealIds = new Set<string>();
  let anyPhoto = false;
  for (const job of jobs) {
    if (job.photoUpload || job.removePhoto) {
      anyPhoto = true;
      photoMealIds.add(job.record.id);
    }
  }
  if (!anyPhoto) {
    return { accountJobs: jobs, photoJobs: [] };
  }
  let nextSeq = jobs.reduce((max, job) => Math.max(max, job.seq ?? 0), 0);
  const sequenced = jobs.map((job) => (job.seq === undefined ? { ...job, seq: ++nextSeq } : job));
  const accountJobs: PendingMeal[] = [];
  const photoJobs: PendingMeal[] = [];
  for (const job of sequenced) {
    if (job.photoUpload || job.removePhoto || photoMealIds.has(job.record.id)) {
      photoJobs.push(job);
    } else {
      accountJobs.push(job);
    }
  }
  return { accountJobs, photoJobs };
}

function hasIsolatedJob(jobs: PendingMeal[]): boolean {
  return jobs.some((job) => Boolean(job.photoUpload || job.removePhoto));
}

async function open() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    // Open the installed schema. A pinned v1 opener fails with VersionError
    // after a later client adds object stores for atomic photo payloads/jobs.
    const request = indexedDB.open("kcalcue-sync");
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("accounts"))
        request.result.createObjectStore("accounts");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Upgrade only when a photo or removePhoto intent is queued. Legacy v1 tabs
// only read `accounts`, so isolating photo/removePhoto/dependent jobs into
// `photoJobs` prevents an old tab from dropping photo intents.
async function openForPhoto() {
  const current = await open();
  if (current.objectStoreNames.contains(PHOTO_STORE) &&
      current.objectStoreNames.contains(PHOTO_JOBS_STORE))
    return current;
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
      if (!db.objectStoreNames.contains(PHOTO_JOBS_STORE)) {
        db.createObjectStore(PHOTO_JOBS_STORE);
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
    || !uuidPattern.test(uploadId)
    || pipelineVersion !== 1
    || blob.type !== "image/jpeg" || blob.size < 1 || blob.size > MAX_PHOTO_BYTES)
    throw new Error("Invalid photo upload intent");
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const payloadBytes = new Uint8Array(buffer);
  const photoUpload: PhotoUploadIntent = { uploadId, pipelineVersion, sha256, byteSize: blob.size, status: "pending" };
  const queued: PendingMeal = { ...job, photoUpload };
  const db = await openForPhoto();
  try {
    return await new Promise<SyncState>((resolve, reject) => {
      const tx = db.transaction(["accounts", PHOTO_JOBS_STORE, PHOTO_STORE], "readwrite");
      const accounts = tx.objectStore("accounts");
      const photoJobsStore = tx.objectStore(PHOTO_JOBS_STORE);
      const photos = tx.objectStore(PHOTO_STORE);
      const request = accounts.get(uid);
      const photoJobsRequest = photoJobsStore.get(uid);
      let value: SyncState;
      let accountResult: SyncState | undefined;
      let photoJobsResult: PendingMeal[] | undefined;
      let accountLoaded = false;
      let photoJobsLoaded = false;

      const tryRun = () => {
        if (!accountLoaded || !photoJobsLoaded) return;
        const base = accountResult ?? empty();
        const current: SyncState = { ...base, jobs: mergeJobs(base.jobs, photoJobsResult ?? []) };
        if (current.remote.some((record) => record.mutationId === job.id)) {
          abortWith(tx, new Error("Mutation already acknowledged"), reject);
          return;
        }
        const existing = current.jobs.find((pending) => pending.id === job.id);
        if (current.jobs.some((pending) => pending.record.id === job.record.id && (pending.error || pending.kind === "delete"))) {
          abortWith(tx, new Error("Conflicting pending meal"), reject);
          return;
        }
        if (existing && !sameJobIntent(existing, queued)) {
          abortWith(tx, new Error("Conflicting photo mutation"), reject);
          return;
        }
        if (!existing && !hasCurrentMealVersion(current, job.record.id, job.expectedVersion)) {
          abortWith(tx, new Error("Conflicting pending meal"), reject);
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
            const nextJobs = [...current.jobs, queued];
            const split = splitJobs(nextJobs);
            value = { ...current, jobs: mergeJobs(split.accountJobs, split.photoJobs) };
            photos.put({
              uid,
              uploadId,
              bytes: payloadBytes,
              type: blob.type,
              sha256,
              byteSize: blob.size,
            } satisfies PhotoPayload);
            accounts.put({ ...base, jobs: split.accountJobs }, uid);
            photoJobsStore.put(split.photoJobs, uid);
          }
        };
      };

      request.onsuccess = () => { accountResult = request.result; accountLoaded = true; tryRun(); };
      photoJobsRequest.onsuccess = () => { photoJobsResult = photoJobsRequest.result; photoJobsLoaded = true; tryRun(); };
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
      request.onsuccess = () => {
        const payload = request.result as PhotoPayload | undefined;
        if (payload?.bytes) {
          value = new Blob([new Uint8Array(payload.bytes)], { type: payload.type || "image/jpeg" });
        } else {
          value = payload?.blob ?? null;
        }
      };
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
    if (!db.objectStoreNames.contains(PHOTO_STORE) ||
        !db.objectStoreNames.contains(PHOTO_JOBS_STORE))
      throw new Error("Photo storage unavailable");
    return await new Promise<SyncState>((resolve, reject) => {
      const tx = db.transaction(["accounts", PHOTO_JOBS_STORE, PHOTO_STORE], "readwrite");
      const accounts = tx.objectStore("accounts");
      const photoJobsStore = tx.objectStore(PHOTO_JOBS_STORE);
      const request = accounts.get(uid);
      const photoJobsRequest = photoJobsStore.get(uid);
      let value: SyncState;
      let accountResult: SyncState | undefined;
      let photoJobsResult: PendingMeal[] | undefined;
      let accountLoaded = false;
      let photoJobsLoaded = false;

      const tryRun = () => {
        if (!accountLoaded || !photoJobsLoaded) return;
        const base = accountResult ?? empty();
        const current: SyncState = { ...base, jobs: mergeJobs(base.jobs, photoJobsResult ?? []) };
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
          const updatedJobs = current.jobs.map((pending) => pending === job ? {
            ...pending, photoUpload: { ...job.photoUpload!, status: "staged" as const },
          } : pending);
          const split = splitJobs(updatedJobs);
          value = { ...current, jobs: mergeJobs(split.accountJobs, split.photoJobs) };
          accounts.put({ ...base, jobs: split.accountJobs }, uid);
          photoJobsStore.put(split.photoJobs, uid);
        };
      };

      request.onsuccess = () => { accountResult = request.result; accountLoaded = true; tryRun(); };
      photoJobsRequest.onsuccess = () => { photoJobsResult = photoJobsRequest.result; photoJobsLoaded = true; tryRun(); };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(storageError(tx, request));
    });
  } finally {
    db.close();
  }
}

export async function replaceExpiredPhotoJobAndPayload(
  uid: string,
  oldUploadId: string,
  newUploadId: string,
  blob: Blob,
  replaceJob: (state: SyncState, newIntent: PhotoUploadIntent) => SyncState,
): Promise<SyncState> {
  if (!uid || !uuidPattern.test(newUploadId)
    || blob.type !== "image/jpeg" || blob.size < 1 || blob.size > MAX_PHOTO_BYTES)
    throw new Error("Invalid photo upload intent");
  const buffer = await blob.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  const sha256 = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const payloadBytes = new Uint8Array(buffer);
  const newIntent: PhotoUploadIntent = {
    uploadId: newUploadId,
    sha256,
    byteSize: blob.size,
    pipelineVersion: 1,
    status: "pending",
  };
  const db = await openForPhoto();
  try {
    return await new Promise<SyncState>((resolve, reject) => {
      const tx = db.transaction(["accounts", PHOTO_JOBS_STORE, PHOTO_STORE], "readwrite");
      const accounts = tx.objectStore("accounts");
      const photoJobsStore = tx.objectStore(PHOTO_JOBS_STORE);
      const photos = tx.objectStore(PHOTO_STORE);
      const request = accounts.get(uid);
      const photoJobsRequest = photoJobsStore.get(uid);
      let value: SyncState;
      let accountResult: SyncState | undefined;
      let photoJobsResult: PendingMeal[] | undefined;
      let accountLoaded = false;
      let photoJobsLoaded = false;

      const tryRun = () => {
        if (!accountLoaded || !photoJobsLoaded) return;
        const base = accountResult ?? empty();
        const current: SyncState = { ...base, jobs: mergeJobs(base.jobs, photoJobsResult ?? []) };
        const payloadRequest = photos.get([uid, newUploadId]);
        payloadRequest.onsuccess = () => {
          if (payloadRequest.result) {
            abortWith(tx, new Error("Photo upload ID already exists"), reject);
            return;
          }
          try {
            const next = replaceJob(current, newIntent);
            if (next.jobs.some((pending) => pending.photoUpload?.uploadId === oldUploadId))
              throw new Error("Cannot clear a queued photo payload");
            const split = splitJobs(next.jobs);
            value = { ...next, jobs: mergeJobs(split.accountJobs, split.photoJobs) };
            photos.put({
              uid,
              uploadId: newUploadId,
              bytes: payloadBytes,
              type: blob.type,
              sha256,
              byteSize: blob.size,
            } satisfies PhotoPayload);
            clearPhotoRows(photos, uid, [oldUploadId]);
            accounts.put({ ...next, jobs: split.accountJobs }, uid);
            photoJobsStore.put(split.photoJobs, uid);
          } catch (error) {
            abortWith(tx, error, reject);
          }
        };
      };

      request.onsuccess = () => { accountResult = request.result; accountLoaded = true; tryRun(); };
      photoJobsRequest.onsuccess = () => { photoJobsResult = photoJobsRequest.result; photoJobsLoaded = true; tryRun(); };
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
    const hasPhotoJobs = db.objectStoreNames.contains(PHOTO_JOBS_STORE);
    if ((!hasPhotos || !hasPhotoJobs) && uploadIds.length)
      throw new Error("Photo storage unavailable");
    const storeNames = ["accounts", ...(hasPhotoJobs ? [PHOTO_JOBS_STORE] : []), ...(hasPhotos ? [PHOTO_STORE] : [])];
    return await new Promise<SyncState>((resolve, reject) => {
      const tx = db.transaction(storeNames, "readwrite");
      const accounts = tx.objectStore("accounts");
      const photoJobsStore = hasPhotoJobs ? tx.objectStore(PHOTO_JOBS_STORE) : null;
      const request = accounts.get(uid);
      const photoJobsRequest = photoJobsStore ? photoJobsStore.get(uid) : null;
      let value: SyncState;
      let accountResult: SyncState | undefined;
      let photoJobsResult: PendingMeal[] | undefined;
      let accountLoaded = false;
      let photoJobsLoaded = !photoJobsRequest;

      const tryRun = () => {
        if (!accountLoaded || !photoJobsLoaded) return;
        try {
          const base = accountResult ?? empty();
          const merged: SyncState = { ...base, jobs: mergeJobs(base.jobs, photoJobsResult ?? []) };
          const next = change(merged);
          if (next.jobs.some((pending) => pending.photoUpload && uploadIds.includes(pending.photoUpload.uploadId)))
            throw new Error("Cannot clear a queued photo payload");
          const split = splitJobs(next.jobs);
          value = { ...next, jobs: mergeJobs(split.accountJobs, split.photoJobs) };
          accounts.put({ ...next, jobs: split.accountJobs }, uid);
          if (photoJobsStore) photoJobsStore.put(split.photoJobs, uid);
          if (hasPhotos) clearPhotoRows(tx.objectStore(PHOTO_STORE), uid, uploadIds);
        } catch (error) {
          abortWith(tx, error, reject);
        }
      };

      request.onsuccess = () => { accountResult = request.result; accountLoaded = true; tryRun(); };
      if (photoJobsRequest) {
        photoJobsRequest.onsuccess = () => {
          photoJobsResult = photoJobsRequest.result;
          photoJobsLoaded = true;
          tryRun();
        };
      }
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(storageError(tx, request));
    });
  } finally {
    db.close();
  }
}

async function runChangeSyncState(
  db: IDBDatabase,
  uid: string,
  change?: (state: SyncState) => SyncState,
): Promise<{ state: SyncState; needsPhotoUpgrade: boolean }> {
  const hasPhotoJobs = db.objectStoreNames.contains(PHOTO_JOBS_STORE);
  const storeNames = hasPhotoJobs ? ["accounts", PHOTO_JOBS_STORE] : ["accounts"];
  let needsPhotoUpgrade = false;
  const state = await new Promise<SyncState>((resolve, reject) => {
    const tx = db.transaction(storeNames, change ? "readwrite" : "readonly");
    const accounts = tx.objectStore("accounts");
    const photoJobsStore = hasPhotoJobs ? tx.objectStore(PHOTO_JOBS_STORE) : null;
    const request = accounts.get(uid);
    const photoJobsRequest = photoJobsStore ? photoJobsStore.get(uid) : null;
    let value: SyncState;
    let accountResult: SyncState | undefined;
    let photoJobsResult: PendingMeal[] | undefined;
    let accountLoaded = false;
    let photoJobsLoaded = !photoJobsRequest;

    const tryRun = () => {
      if (!accountLoaded || !photoJobsLoaded) return;
      try {
        const base = accountResult ?? empty();
        const merged: SyncState = { ...base, jobs: mergeJobs(base.jobs, photoJobsResult ?? []) };
        if (!change) {
          value = merged;
          return;
        }
        const next = change(structuredClone(merged));
        if (!hasPhotoJobs && hasIsolatedJob(next.jobs)) {
          needsPhotoUpgrade = true;
          tx.abort();
          return;
        }
        const split = splitJobs(next.jobs);
        value = { ...next, jobs: mergeJobs(split.accountJobs, split.photoJobs) };
        accounts.put({ ...next, jobs: split.accountJobs }, uid);
        if (photoJobsStore) photoJobsStore.put(split.photoJobs, uid);
      } catch (error) {
        abortWith(tx, error, reject);
      }
    };

    request.onsuccess = () => { accountResult = request.result; accountLoaded = true; tryRun(); };
    if (photoJobsRequest) {
      photoJobsRequest.onsuccess = () => {
        photoJobsResult = photoJobsRequest.result;
        photoJobsLoaded = true;
        tryRun();
      };
    }
    tx.oncomplete = () => resolve(value);
    tx.onerror = tx.onabort = () => {
      if (needsPhotoUpgrade) resolve(empty());
      else reject(storageError(tx, request));
    };
  });
  return { state, needsPhotoUpgrade };
}

// One IDB transaction prevents tabs losing each other's queued changes.
// Photo/removePhoto/dependent jobs are stored in `photoJobs` so legacy tabs
// reading only `accounts` cannot consume or drop them.
export async function changeSyncState(
  uid: string,
  change?: (state: SyncState) => SyncState,
): Promise<SyncState> {
  const db = await open();
  try {
    const result = await runChangeSyncState(db, uid, change);
    if (!result.needsPhotoUpgrade) return result.state;
  } finally {
    db.close();
  }
  const upgraded = await openForPhoto();
  try {
    const result = await runChangeSyncState(upgraded, uid, change);
    return result.state;
  } finally {
    upgraded.close();
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
      const photoRefPatch = job.removePhoto
        ? { photoRef: null }
        : previous && "photoRef" in previous
          ? { photoRef: previous.photoRef }
          : confirmed && "photoRef" in confirmed
            ? { photoRef: confirmed.photoRef }
            : {};
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
        ...("journalNote" in job.record
          ? { journalNote: job.record.journalNote ?? null }
          : previous && "journalNote" in previous
            ? { journalNote: previous.journalNote ?? null }
            : {}),
        ...(confirmed ? {
          schemaVersion: confirmed.schemaVersion,
          createdAt: confirmed.createdAt,
        } : {}),
        ...photoRefPatch,
      });
    }
  }
  return [...meals.values()];
}

export async function clearSyncState(uid: string) {
  const db = await open();
  try {
    const hasPhotos = db.objectStoreNames.contains(PHOTO_STORE);
    const hasPhotoJobs = db.objectStoreNames.contains(PHOTO_JOBS_STORE);
    const storeNames = ["accounts", ...(hasPhotoJobs ? [PHOTO_JOBS_STORE] : []), ...(hasPhotos ? [PHOTO_STORE] : [])];
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(storeNames, "readwrite");
      tx.objectStore("accounts").put(empty(), uid);
      if (hasPhotoJobs) tx.objectStore(PHOTO_JOBS_STORE).put([], uid);
      if (hasPhotos) clearPhotoRows(tx.objectStore(PHOTO_STORE), uid);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(storageError(tx));
    });
  } finally {
    db.close();
  }
}
