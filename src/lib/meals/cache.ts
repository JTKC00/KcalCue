import type { MealDraft, MealRecord } from "./types";

export interface LocalMeals {
  records: MealRecord[];
  draft: MealDraft | null;
  syncedAt: string | null;
}
const empty = (): LocalMeals => ({ records: [], draft: null, syncedAt: null });
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("kcalcue-private", 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore("accounts");
      request.result.createObjectStore("photos");
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transact<T>(
  store: string,
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(store, mode);
      const request = operation(tx.objectStore(store));
      tx.oncomplete = () => resolve(request.result);
      tx.onerror = tx.onabort = () => reject(tx.error ?? request.error);
    });
  } finally {
    db.close();
  }
}
export const localMeals = {
  async read(userId: string): Promise<LocalMeals> {
    return (
      (await transact<LocalMeals | undefined>("accounts", "readonly", (s) =>
        s.get(userId),
      )) ?? empty()
    );
  },
  async write(userId: string, state: LocalMeals) {
    await transact("accounts", "readwrite", (s) => s.put(state, userId));
  },
  async photo(userId: string, path: string): Promise<Blob | undefined> {
    return transact("photos", "readonly", (s) => s.get(`${userId}/${path}`));
  },
  async putPhoto(userId: string, path: string, blob: Blob) {
    await transact("photos", "readwrite", (s) =>
      s.put(blob, `${userId}/${path}`),
    );
  },
  async removePhoto(userId: string, path: string) {
    await transact("photos", "readwrite", (s) => s.delete(`${userId}/${path}`));
  },
  async clear(userId: string) {
    await transact("accounts", "readwrite", (s) => s.delete(userId));
    const keys = await transact<IDBValidKey[]>("photos", "readonly", (s) =>
      s.getAllKeys(),
    );
    for (const key of keys)
      if (String(key).startsWith(`${userId}/`))
        await transact("photos", "readwrite", (s) => s.delete(key));
  },
};
