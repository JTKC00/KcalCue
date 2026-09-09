import type { MealRecord } from "./types";
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
    const request = indexedDB.open("kcalcue-sync", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("accounts");
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
  const meals = new Map(state.remote.map((record) => [record.id, record]));
  for (const job of state.jobs) {
    if (job.kind === "delete") meals.delete(job.record.id);
    else meals.set(job.record.id, job.record);
  }
  return [...meals.values()];
}
export async function clearSyncState(uid: string) {
  await changeSyncState(uid, empty);
}
