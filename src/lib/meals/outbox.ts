import type { MealRecord } from "./types";
import { resolveCalorieCorrection } from "./calories";
import { readAnalysisProvenance } from "@/lib/domain/analysis-provenance";
export interface PendingMeal {
  id: string;
  kind: "save" | "delete";
  record: MealRecord;
  expectedVersion: number;
  error?: string;
}
export interface SyncState {
  remote: MealRecord[];
  jobs: PendingMeal[];
  syncedAt: string | null;
  revision?: string;
}
const empty = (): SyncState => ({ remote: [], jobs: [], syncedAt: null });
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
  await changeSyncState(uid, empty);
}
