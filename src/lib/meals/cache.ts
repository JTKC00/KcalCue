import type { MealDraft, MealRecord } from "./types";

export interface LocalMeals {
  records: MealRecord[];
  draft: MealDraft | null;
  syncedAt: string | null;
}
const empty = (): LocalMeals => ({ records: [], draft: null, syncedAt: null });
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("kcalcue-private", 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains("accounts"))
        request.result.createObjectStore("accounts");
      if (request.result.objectStoreNames.contains("photos"))
        request.result.deleteObjectStore("photos");
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
  async clear(userId: string) {
    await transact("accounts", "readwrite", (s) => s.delete(userId));
  },
};
