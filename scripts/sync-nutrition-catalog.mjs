import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  SHARDS_COLLECTION,
  applySourceShards,
  getTargetFirestore,
  packSourceShards,
  resolveProjectTarget,
} from "./catalog/shared.mjs";
import { fetchMcDonaldsHkSource } from "./catalog/sources/mcdonalds-hk.mjs";
import { fetchCfsHkFrlSource } from "./catalog/sources/cfs-hk-frl.mjs";
import { fetchTfndTwSource } from "./catalog/sources/tfnd-tw.mjs";
import { fetchUsdaFdcSource } from "./catalog/sources/usda-fdc.mjs";
import { fetchOpenFoodFactsHkTwSource } from "./catalog/sources/openfoodfacts-hktw.mjs";

export const SOURCE_LOADERS = {
  "mcdonalds-hk": fetchMcDonaldsHkSource,
  "cfs-hk-frl": fetchCfsHkFrlSource,
  "tfnd-tw": fetchTfndTwSource,
  "usda-fdc": fetchUsdaFdcSource,
  "openfoodfacts-hktw": fetchOpenFoodFactsHkTwSource,
};

export const SOURCE_MIN_ENTRIES = {
  "mcdonalds-hk": 40,
  "cfs-hk-frl": 500,
  "tfnd-tw": 1500,
  "usda-fdc": 5000,
  "openfoodfacts-hktw": 500,
};

export const ALL_SOURCE_KEYS = Object.keys(SOURCE_LOADERS);

function minEntriesForSource(sourceKey) {
  if (sourceKey === "openfoodfacts-hktw") {
    const customPages = process.env.OFF_HK_MAX_PAGES || process.env.OFF_TW_MAX_PAGES;
    if (customPages) return 1;
  }
  return SOURCE_MIN_ENTRIES[sourceKey] ?? 1;
}

export function parseRequestedSources(raw) {
  if (!raw || raw === "all") return ALL_SOURCE_KEYS;
  const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const key of requested) {
    if (!(key in SOURCE_LOADERS)) {
      throw new Error(`Unknown source "${key}". Valid sources: all, ${ALL_SOURCE_KEYS.join(", ")}`);
    }
  }
  return [...new Set(requested)];
}

export async function buildShardsForSources(
  sourceKeys,
  syncedAt = new Date().toISOString(),
  options = {},
) {
  const retrievedAt = syncedAt.slice(0, 10);
  const force = Boolean(options.force);
  const results = [];

  for (const sourceKey of sourceKeys) {
    const loader = SOURCE_LOADERS[sourceKey];
    const loaded = await loader(retrievedAt);
    const minEntries = minEntriesForSource(sourceKey);
    if (!force && loaded.entries.length < minEntries) {
      throw new Error(
        `Source "${sourceKey}" produced only ${loaded.entries.length} entries (expected >= ${minEntries}). Aborting to protect catalog integrity; pass --force to override.`,
      );
    }
    const shards = packSourceShards(sourceKey, loaded.defaults, loaded.entries, syncedAt);
    const totalBytes = shards.reduce((sum, shard) => sum + Buffer.byteLength(JSON.stringify(shard), "utf8"), 0);
    results.push({
      sourceKey,
      entryCount: loaded.entries.length,
      shardCount: shards.length,
      totalBytes,
      meta: loaded.meta,
      shards,
    });
  }

  return results;
}

export async function runCatalogSync(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: {
      source: { type: "string", default: "all" },
      apply: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      project: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(`Sync sharded nutrition catalog sources into Firestore (${SHARDS_COLLECTION})
  node scripts/sync-nutrition-catalog.mjs [--source all|${ALL_SOURCE_KEYS.join("|")}] [--dry-run]
  node scripts/sync-nutrition-catalog.mjs --source all --apply [--project <firebase-project-id>] [--force]

Defaults to --dry-run (fetches, parses, packs shards, checks Firestore compatibility and entry floors without writing).
Respects FIRESTORE_EMULATOR_HOST when set. Optional OFF_HK_MAX_PAGES / OFF_TW_MAX_PAGES / OFF_MIN_INTERVAL_MS tune OFF sync.`);
    return;
  }

  const apply = Boolean(values.apply) && !values["dry-run"];
  const force = Boolean(values.force);
  const sourceKeys = parseRequestedSources(values.source);
  const projectTarget = apply ? resolveProjectTarget(values.project) : null;
  const syncedAt = new Date().toISOString();
  const built = await buildShardsForSources(sourceKeys, syncedAt, { force });

  const summary = {
    mode: apply ? "apply" : "dry-run",
    collection: SHARDS_COLLECTION,
    ...(projectTarget ? { targetProject: projectTarget.projectId, projectSource: projectTarget.source } : {}),
    totalEntries: built.reduce((sum, item) => sum + item.entryCount, 0),
    totalShards: built.reduce((sum, item) => sum + item.shardCount, 0),
    totalBytes: built.reduce((sum, item) => sum + item.totalBytes, 0),
    sources: built.map(({ sourceKey, entryCount, shardCount, totalBytes, meta }) => ({
      sourceKey,
      entryCount,
      shardCount,
      totalKB: Math.round(totalBytes / 1024),
      meta,
    })),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (!apply) {
    console.log("\nDry run complete. Pass --apply to write shards to Firestore.");
    return;
  }

  const db = getTargetFirestore(projectTarget.projectId);
  const target = process.env.FIRESTORE_EMULATOR_HOST
    ? `emulator (${process.env.FIRESTORE_EMULATOR_HOST})`
    : `project ${projectTarget.projectId} (via ${projectTarget.source})`;

  const writeResults = {};
  for (const item of built) {
    writeResults[item.sourceKey] = await applySourceShards(db, item.sourceKey, item.shards, syncedAt, { force });
  }
  console.log(`Synced to Firestore ${target}:`, JSON.stringify(writeResults, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  runCatalogSync().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
