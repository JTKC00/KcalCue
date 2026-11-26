import { gunzipSync } from "node:zlib";
import type { Firestore } from "firebase-admin/firestore";
import { adminServices } from "./admin";
import {
  buildCatalogIndex,
  emptyCatalogIndex,
  firestoreCatalogShardSchema,
  type CatalogIndex,
  type FirestoreCatalogShard,
} from "@/lib/nutrition/catalog-entry";

export const NUTRITION_CATALOG_SHARDS_COLLECTION = "kcalcueNutritionCatalogShards";
export const DEFAULT_CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_CATALOG_LOAD_TIMEOUT_MS = 8 * 1000;
const MAX_SHARD_GUNZIP_BYTES = 4 * 1024 * 1024;
const ERROR_RETRY_COOLDOWN_MS = 30 * 1000;

function decodeRawShardDoc(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const record = raw as Record<string, unknown>;
  if (!(record.entriesGzip instanceof Uint8Array)) return raw;
  try {
    const jsonText = gunzipSync(Buffer.from(record.entriesGzip), {
      maxOutputLength: MAX_SHARD_GUNZIP_BYTES,
    }).toString("utf8");
    const entries = JSON.parse(jsonText);
    if (!Array.isArray(entries)) return null;
    if (typeof record.entryCount === "number" && record.entryCount !== entries.length) {
      return null;
    }
    const { entriesGzip: _omitGzip, entryCount: _omitCount, ...rest } = record;
    void _omitGzip;
    void _omitCount;
    return { ...rest, entries };
  } catch {
    return null;
  }
}

interface CatalogCacheState {
  index: CatalogIndex;
  shardsBySource: Map<string, FirestoreCatalogShard[]>;
  expiresAt: number;
  inflight: Promise<CatalogIndex> | null;
}

const cacheByDb = new WeakMap<Firestore, CatalogCacheState>();

function isQueryableFirestore(db: Firestore | null | undefined): db is Firestore {
  return Boolean(db && typeof db.collection === "function");
}

function selectCompleteShardsBySource(
  validShards: readonly FirestoreCatalogShard[],
): {
  completeBySource: Map<string, FirestoreCatalogShard[]>;
  incompleteSources: string[];
  incompleteNewerVersions: string[];
} {
  const grouped = new Map<string, Map<string, FirestoreCatalogShard[]>>();
  for (const shard of validShards) {
    if (!shard.active) continue;
    let byVersion = grouped.get(shard.sourceKey);
    if (!byVersion) {
      byVersion = new Map();
      grouped.set(shard.sourceKey, byVersion);
    }
    const list = byVersion.get(shard.syncedAt);
    if (list) list.push(shard);
    else byVersion.set(shard.syncedAt, [shard]);
  }

  const completeBySource = new Map<string, FirestoreCatalogShard[]>();
  const incompleteSources: string[] = [];
  const incompleteNewerVersions: string[] = [];

  for (const [sourceKey, byVersion] of grouped) {
    const versions = [...byVersion.entries()].sort(([a], [b]) => b.localeCompare(a));
    let chosen: FirestoreCatalogShard[] | null = null;
    let chosenIndex = -1;
    for (let idx = 0; idx < versions.length; idx++) {
      const [, versionShards] = versions[idx]!;
      const expectedCount = versionShards[0]?.shardCount ?? 0;
      if (expectedCount <= 0 || versionShards.length !== expectedCount) continue;
      const seenIndexes = new Set<number>();
      let valid = true;
      for (const shard of versionShards) {
        if (
          shard.shardCount !== expectedCount ||
          shard.shardIndex < 0 ||
          shard.shardIndex >= expectedCount ||
          seenIndexes.has(shard.shardIndex)
        ) {
          valid = false;
          break;
        }
        seenIndexes.add(shard.shardIndex);
      }
      if (valid && seenIndexes.size === expectedCount) {
        chosen = versionShards;
        chosenIndex = idx;
        break;
      }
    }
    if (chosen) {
      completeBySource.set(sourceKey, chosen);
      if (chosenIndex > 0) {
        incompleteNewerVersions.push(sourceKey);
      }
    } else {
      incompleteSources.push(sourceKey);
    }
  }

  return { completeBySource, incompleteSources, incompleteNewerVersions };
}

export function getNutritionCatalogDb(): Firestore | null {
  if (!process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID) return null;
  try {
    return adminServices().db;
  } catch {
    return null;
  }
}

export function clearNutritionCatalogCache(db?: Firestore): void {
  if (db) {
    cacheByDb.delete(db);
  }
}

export async function loadFirestoreNutritionCatalogIndex(
  db: Firestore | null | undefined,
  options?: { ttlMs?: number; now?: number; forceRefresh?: boolean; timeoutMs?: number },
): Promise<CatalogIndex> {
  if (!isQueryableFirestore(db)) return emptyCatalogIndex();

  const ttlMs = options?.ttlMs ?? DEFAULT_CATALOG_CACHE_TTL_MS;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_CATALOG_LOAD_TIMEOUT_MS;
  const now = options?.now ?? Date.now();
  const existing = cacheByDb.get(db);

  if (!options?.forceRefresh && existing && existing.expiresAt > now) {
    return existing.index;
  }
  if (existing?.inflight) {
    return existing.inflight;
  }

  const state: CatalogCacheState = existing ?? {
    index: emptyCatalogIndex(),
    shardsBySource: new Map(),
    expiresAt: 0,
    inflight: null,
  };
  cacheByDb.set(db, state);

  let settled = false;
  const loadPromise = (async () => {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    try {
      // Yield a microtask so `state.inflight = loadPromise` always runs before `finally`
      // even if a mock `db.collection()` throws synchronously.
      await Promise.resolve();
      const queryPromise = db
        .collection(NUTRITION_CATALOG_SHARDS_COLLECTION)
        .where("active", "==", true)
        .get();
      const snapshot = timeoutMs > 0
        ? await Promise.race([
          queryPromise,
          new Promise<never>((_, reject) => {
            timeoutHandle = setTimeout(() => reject(new Error("catalog_load_timeout")), timeoutMs);
            if (typeof timeoutHandle === "object" && "unref" in timeoutHandle) {
              timeoutHandle.unref();
            }
          }),
        ])
        : await queryPromise;

      const validShards: FirestoreCatalogShard[] = [];
      const invalidSources = new Set<string>();
      let skippedShards = 0;
      for (const doc of snapshot.docs) {
        const raw = doc.data();
        const decoded = decodeRawShardDoc(raw);
        const parsed = firestoreCatalogShardSchema.safeParse(decoded);
        if (parsed.success) {
          validShards.push(parsed.data);
        } else {
          skippedShards += 1;
          if (raw && typeof raw.sourceKey === "string" && raw.sourceKey.trim()) {
            invalidSources.add(raw.sourceKey.trim());
          }
        }
      }

      const { completeBySource, incompleteSources, incompleteNewerVersions } =
        selectCompleteShardsBySource(validShards);

      // If NO complete shard set was returned (including an unexpectedly empty snapshot or
      // all-invalid/incomplete docs), preserve any usable stale index and retry on short cooldown.
      if (completeBySource.size === 0 && state.index.entryCount > 0) {
        console.error("[kcalcue:nutrition-catalog]", {
          loadFailed: true,
          emptyOrAllInvalidSnapshot: true,
          docCount: snapshot.docs.length,
          skippedInvalidShards: skippedShards,
          incompleteSources,
          staleEntries: state.index.entryCount,
        });
        state.expiresAt = now + Math.min(ttlMs, ERROR_RETRY_COOLDOWN_MS);
        return state.index;
      }

      const mergedBySource = new Map<string, FirestoreCatalogShard[]>(completeBySource);
      const missingSources: string[] = [];
      // Retain the last known complete shard set for any previously cached source that is
      // incomplete, invalid, or completely missing from this snapshot, and retry on short cooldown.
      for (const [prevSourceKey, prevShards] of state.shardsBySource) {
        if (!mergedBySource.has(prevSourceKey) && prevShards.length > 0) {
          mergedBySource.set(prevSourceKey, prevShards);
          if (!incompleteSources.includes(prevSourceKey) && !invalidSources.has(prevSourceKey)) {
            missingSources.push(prevSourceKey);
          }
        }
      }

      const degraded =
        skippedShards > 0 ||
        incompleteSources.length > 0 ||
        incompleteNewerVersions.length > 0 ||
        missingSources.length > 0;

      const activeShards = [...mergedBySource.values()].flat();
      const nextIndex = buildCatalogIndex(activeShards);
      state.shardsBySource = mergedBySource;
      state.index = nextIndex;
      state.expiresAt = now + (degraded ? Math.min(ttlMs, ERROR_RETRY_COOLDOWN_MS) : ttlMs);

      if (degraded) {
        console.error("[kcalcue:nutrition-catalog]", {
          loadedShards: activeShards.length,
          loadedEntries: nextIndex.entryCount,
          skippedInvalidShards: skippedShards,
          incompleteSources,
          incompleteNewerVersions,
          missingSources,
        });
      }
      return nextIndex;
    } catch (error) {
      console.error("[kcalcue:nutrition-catalog]", {
        loadFailed: true,
        timedOut: error instanceof Error && error.message === "catalog_load_timeout",
        staleEntries: state.index.entryCount,
      });
      state.expiresAt = now + Math.min(ttlMs, ERROR_RETRY_COOLDOWN_MS);
      return state.index;
    } finally {
      if (timeoutHandle !== null) clearTimeout(timeoutHandle);
      settled = true;
      state.inflight = null;
    }
  })();

  if (!settled) {
    state.inflight = loadPromise;
  }
  return loadPromise;
}
