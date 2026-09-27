import type { MealDraft, MealRecord } from "./types";

export interface LocalMeals {
  records: MealRecord[];
  draft: MealDraft | null;
  syncedAt: string | null;
}
type StoredMeals = LocalMeals & {
  draftRevision?: string | null;
  draftUpdatedAt?: number;
};
type ScopedDraft = { draft: MealDraft | null; revision: string | null; updatedAt: number };
export interface SavedDraftSummary {
  tabId: string;
  revision: string;
  mealId: string;
  label: string;
  date: string;
  updatedAt: number;
}
const draftKey = (userId: string, tabId: string): IDBValidKey =>
  ["draft", userId, tabId];
const empty = (): LocalMeals => ({ records: [], draft: null, syncedAt: null });
let memoryTabId: string | null = null;
let tabReady: Promise<string> | null = null;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function prepareDraftTabId(): Promise<string> {
  if (memoryTabId) return Promise.resolve(memoryTabId);
  if (tabReady) return tabReady;
  tabReady = (async () => {
    let stored: string | null = null;
    try { stored = sessionStorage.getItem("kcalcue-draft-tab"); } catch { /* private mode */ }
    let candidate = stored && uuid.test(stored) ? stored : crypto.randomUUID();
    if (navigator.locks?.request) {
      // sessionStorage can be cloned into a new window with an opener. Hold a
      // per-tab lock for this document so a clone chooses a different key.
      let claimed = false;
      for (let attempt = 0; attempt < 4 && !claimed; attempt++) {
        const key = candidate;
        claimed = await new Promise<boolean>((resolve) => {
          void navigator.locks.request(`kcalcue-draft-tab-${key}`, { ifAvailable: true },
            async (lock) => {
              resolve(!!lock);
              if (lock) await new Promise<void>(() => { /* held until page unload */ });
            }).catch(() => resolve(false));
        });
        if (!claimed) candidate = crypto.randomUUID();
      }
      if (!claimed) candidate = crypto.randomUUID();
    } else {
      // Unique for this document when Web Locks are unavailable; the latest
      // account copy and recoverable list keep reloads accessible.
      candidate = crypto.randomUUID();
    }
    memoryTabId = candidate;
    try { sessionStorage.setItem("kcalcue-draft-tab", candidate); } catch { /* private mode */ }
    return candidate;
  })();
  return tabReady;
}
export function draftTabId(): string {
  if (!memoryTabId) throw new Error("Draft tab is not initialized");
  return memoryTabId;
}
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
  async read(userId: string, tabId?: string): Promise<LocalMeals> {
    if (tabId) return this.readScoped(userId, tabId);
    return (
      (await transact<LocalMeals | undefined>("accounts", "readonly", (s) =>
        s.get(userId),
      )) ?? empty()
    );
  },
  async write(userId: string, state: LocalMeals, tabId?: string) {
    if (tabId) return this.writeScoped(userId, tabId, state);
    await transact("accounts", "readwrite", (s) => s.put(state, userId));
  },
  async writeSnapshot(userId: string, state: Pick<LocalMeals, "records" | "syncedAt">) {
    const db = await open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("accounts", "readwrite");
        const store = tx.objectStore("accounts");
        const account = store.get(userId);
        account.onsuccess = () => store.put({
          ...((account.result as StoredMeals | undefined) ?? empty()),
          records: state.records,
          syncedAt: state.syncedAt,
        } satisfies StoredMeals, userId);
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  // A tab's unsaved work has its own key. A different tab may refresh its
  // account snapshot without changing this draft, even if it loaded earlier.
  async readScoped(userId: string, tabId: string): Promise<LocalMeals> {
    const db = await open();
    try {
      return await new Promise<LocalMeals>((resolve, reject) => {
        const tx = db.transaction("accounts", "readwrite");
        const store = tx.objectStore("accounts");
        let result = empty();
        const account = store.get(userId);
        account.onsuccess = () => {
          const stored: StoredMeals = (account.result as StoredMeals | undefined) ?? empty();
          const scoped = store.get(draftKey(userId, tabId));
          scoped.onsuccess = () => {
            let owned = scoped.result as ScopedDraft | undefined;
            if (owned === undefined) {
              // A fresh tab resumes the latest draft after its original tab
              // closes. A distinct active tab keeps its own scoped copy.
              const revision = stored.draft
                ? stored.draftRevision ?? crypto.randomUUID() : null;
              owned = {
                draft: stored.draft ?? null,
                revision,
                updatedAt: stored.draftUpdatedAt ?? Date.now(),
              };
              store.put(owned, draftKey(userId, tabId));
              if (stored.draft && !stored.draftRevision)
                store.put({ ...stored, draftRevision: revision }, userId);
            }
            result = {
              records: stored.records ?? [],
              syncedAt: stored.syncedAt ?? null,
              draft: owned.draft,
            };
          };
        };
        tx.oncomplete = () => resolve(result);
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  async writeScoped(userId: string, tabId: string, state: LocalMeals): Promise<void> {
    const db = await open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("accounts", "readwrite");
        const store = tx.objectStore("accounts");
        const account = store.get(userId);
        account.onsuccess = () => {
          const stored: StoredMeals = (account.result as StoredMeals | undefined) ?? empty();
          const scoped = store.get(draftKey(userId, tabId));
          scoped.onsuccess = () => {
            const prior = scoped.result as ScopedDraft | undefined;
            const revision = state.draft ? crypto.randomUUID() : null;
            const updatedAt = Date.now();
            const staleSameDraft = !!state.draft && !!prior?.draft &&
              prior.draft.id === state.draft.id &&
              (!stored.draft || stored.draft.id === state.draft.id) &&
              prior.revision !== stored.draftRevision;
            // Clear the rollback copy only if this tab still owns its exact
            // revision. A stale sibling cannot erase a newer edited draft.
            const clearLegacy = !state.draft && prior?.revision != null &&
              prior.revision === stored.draftRevision;
            store.put({
              records: state.records,
              syncedAt: state.syncedAt,
              draft: state.draft && !staleSameDraft
                ? state.draft : (clearLegacy ? null : stored.draft),
              draftRevision: state.draft && !staleSameDraft ? revision
                : clearLegacy ? null : stored.draftRevision,
              draftUpdatedAt: state.draft && !staleSameDraft ? updatedAt
                : stored.draftUpdatedAt,
            } satisfies StoredMeals, userId);
            store.put({ draft: state.draft, revision, updatedAt } satisfies ScopedDraft,
              draftKey(userId, tabId));
          };
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  async listDrafts(userId: string): Promise<SavedDraftSummary[]> {
    const db = await open();
    try {
      return await new Promise<SavedDraftSummary[]>((resolve, reject) => {
        const tx = db.transaction("accounts", "readonly");
        const cursor = tx.objectStore("accounts").openCursor();
        const drafts: SavedDraftSummary[] = [];
        cursor.onsuccess = () => {
          const row = cursor.result;
          if (!row) return;
          const key = row.key;
          if (Array.isArray(key) && key[0] === "draft" &&
            key[1] === userId && typeof key[2] === "string") {
            const owned = row.value as ScopedDraft;
            if (owned?.draft && typeof owned.revision === "string") {
              const draft = owned.draft;
              drafts.push({
                tabId: key[2], revision: owned.revision,
                mealId: draft.id,
                label: draft.items.map((item) => item.displayName).filter(Boolean).join("、") || "未命名草稿",
                date: draft.date,
                updatedAt: owned.updatedAt ?? 0,
              });
            }
          }
          row.continue();
        };
        tx.oncomplete = () => resolve(drafts.sort((a, b) => b.updatedAt - a.updatedAt));
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  async restoreDraft(userId: string, tabId: string, sourceTabId: string): Promise<MealDraft> {
    const db = await open();
    try {
      return await new Promise<MealDraft>((resolve, reject) => {
        const tx = db.transaction("accounts", "readwrite");
        const store = tx.objectStore("accounts");
        let draft: MealDraft | null = null;
        const source = store.get(draftKey(userId, sourceTabId));
        source.onsuccess = () => {
          const candidate = source.result as ScopedDraft | undefined;
          if (!candidate?.draft || !candidate.revision) {
            tx.abort();
            return;
          }
          const current = store.get(draftKey(userId, tabId));
          current.onsuccess = () => {
            const prior = current.result as ScopedDraft | undefined;
            if (prior?.draft && prior.revision !== candidate.revision)
              store.put(prior, draftKey(userId, crypto.randomUUID()));
            // The source tab retains its old revision. The recovered copy
            // needs a new owner so the source cannot later clear its latest.
            const promoted: ScopedDraft = { ...candidate,
              revision: crypto.randomUUID(), updatedAt: Date.now() };
            store.put(promoted, draftKey(userId, tabId));
            const account = store.get(userId);
            account.onsuccess = () => {
              const stored = (account.result as StoredMeals | undefined) ?? empty();
              // A deliberate recovery becomes the default for a later fresh
              // tab, while the previous draft remains in its scoped row.
              store.put({ ...stored, draft: promoted.draft,
                draftRevision: promoted.revision,
                draftUpdatedAt: promoted.updatedAt } satisfies StoredMeals, userId);
              draft = candidate.draft;
            };
          };
        };
        tx.oncomplete = () => resolve(draft!);
        tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Draft unavailable"));
      });
    } finally { db.close(); }
  },
  async clearScoped(userId: string, tabId: string): Promise<void> {
    const db = await open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("accounts", "readwrite");
        const store = tx.objectStore("accounts");
        const scoped = store.get(draftKey(userId, tabId));
        scoped.onsuccess = () => {
          const prior = scoped.result as ScopedDraft | undefined;
          const account = store.get(userId);
          account.onsuccess = () => {
            const stored = account.result as StoredMeals | undefined;
            if (stored && prior?.revision != null &&
              prior.revision === stored.draftRevision)
              store.put({ ...stored, draft: null, draftRevision: null }, userId);
            store.delete(draftKey(userId, tabId));
          };
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
  async clear(userId: string, tabId?: string) {
    if (tabId) return this.clearScoped(userId, tabId);
    const db = await open();
    try {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("accounts", "readwrite");
        const store = tx.objectStore("accounts");
        store.delete(userId);
        const cursor = store.openKeyCursor();
        cursor.onsuccess = () => {
          const entry = cursor.result;
          if (!entry) return;
          const key = entry.key;
          if (Array.isArray(key) && key[0] === "draft" && key[1] === userId)
            store.delete(key);
          entry.continue();
        };
        tx.oncomplete = () => resolve();
        tx.onerror = tx.onabort = () => reject(tx.error);
      });
    } finally { db.close(); }
  },
};
