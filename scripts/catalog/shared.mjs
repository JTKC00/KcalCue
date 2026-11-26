import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync, inflateRawSync } from "node:zlib";
import { applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { z } from "zod";

export const SHARDS_COLLECTION = "kcalcueNutritionCatalogShards";
export const SHARD_SCHEMA_VERSION = 2;
export const MAX_SHARD_JSON_BYTES = 2_400_000;
export const MAX_SHARD_GZIP_BYTES = 260_000;
export const MAX_SHARD_DOC_BYTES = 850_000;
export const MAX_BATCH_BYTES = 8_000_000;
export const SYNC_USER_AGENT = "KcalCueCatalogSync/2.0 (+https://kcalcue.snugzap.com)";

const portionUnits = ["g", "ml", "piece", "bowl", "cup"];
const compactNutrientSchema = z.union([
  z.number().finite().nonnegative(),
  z.tuple([
    z.number().finite().nonnegative(),
    z.number().finite().nonnegative(),
  ]).refine(([min, max]) => max >= min),
]);

export const sourceDefaultsSchema = z.object({
  sourceKey: z.string().min(1).max(80),
  kind: z.enum(["branded", "packaged_branded", "regional_hk", "regional_tw", "usda_offline"]),
  priority: z.number().int().min(1).max(1000),
  provider: z.literal("kcalcue-reference"),
  sourceLabel: z.string().min(1).max(120),
  attribution: z.string().min(1).max(400),
  dataNotice: z.string().min(1).max(400),
  brandAliases: z.array(z.string().min(1).max(80)).max(30),
  retrievedAt: z.string().min(1).max(32),
});

export const compactEntrySchema = z.object({
  id: z.string().min(1).max(120),
  displayName: z.string().min(1).max(200),
  canonicalName: z.string().min(1).max(120),
  category: z.enum([
    "rice", "noodles", "bread", "poultry", "beef", "pork", "seafood", "egg",
    "vegetable", "fruit", "tofu", "dairy", "sauce", "fried", "mixed", "unknown",
  ]),
  preparations: z.array(z.enum([
    "raw", "cooked", "steamed", "boiled", "pan_fried", "grilled", "stir_fried",
    "deep_fried", "sauced", "unknown",
  ])).min(1),
  composite: z.boolean(),
  exclusiveAliases: z.array(z.string().min(1).max(200)).max(80).optional(),
  brandedAliases: z.array(z.string().min(1).max(200)).max(80).optional(),
  itemBrandAliases: z.array(z.string().min(1).max(80)).max(12).optional(),
  barcode: z.string().regex(/^\d{8,14}$/).optional(),
  searchText: z.string().min(1).max(240).optional(),
  kcal: compactNutrientSchema,
  protein: compactNutrientSchema,
  carbs: compactNutrientSchema,
  fat: compactNutrientSchema,
  gramsPerUnit: z.partialRecord(z.enum(portionUnits), z.number().finite().positive()),
  sourceId: z.string().min(1).max(120),
  sourceName: z.string().min(1).max(240).optional(),
  densityBasis: z.string().min(1).max(400),
});

export const shardSchema = z.object({
  schemaVersion: z.literal(SHARD_SCHEMA_VERSION),
  sourceKey: z.string().min(1).max(80),
  shardIndex: z.number().int().nonnegative(),
  shardCount: z.number().int().positive(),
  syncedAt: z.iso.datetime(),
  active: z.boolean(),
  entryCount: z.number().int().nonnegative().optional(),
  defaults: sourceDefaultsSchema,
  entries: z.array(compactEntrySchema).optional(),
  entriesGzip: z.instanceof(Uint8Array).optional(),
}).refine((shard) => Array.isArray(shard.entries) || shard.entriesGzip instanceof Uint8Array, {
  message: "Shard must provide either entries or entriesGzip",
});

export function round1(value) {
  return Math.round(Math.max(0, value) * 10) / 10;
}

export function bandAround(value, ratio = 0.15) {
  const min = round1(Math.max(0, value * (1 - ratio)));
  const max = round1(Math.max(min, value * (1 + ratio)));
  return min === max ? min : [min, max];
}

export function cleanName(value) {
  return String(value ?? "")
    .replace(/[®™©]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function uniqueStrings(values, maxCount = 60) {
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const cleaned = cleanName(raw);
    if (!cleaned || cleaned.length > 200) continue;
    const key = cleaned.normalize("NFKC").toLocaleLowerCase("en");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(cleaned);
    if (out.length >= maxCount) break;
  }
  return out;
}

export async function fetchBuffer(url, timeoutMs = 45_000) {
  const response = await fetch(url, {
    headers: { "User-Agent": SYNC_USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return Buffer.from(await response.arrayBuffer());
}

export async function fetchText(url, timeoutMs = 20_000) {
  const response = await fetch(url, {
    headers: { "User-Agent": SYNC_USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.text();
}

export async function fetchJson(url, timeoutMs = 20_000) {
  const response = await fetch(url, {
    headers: { "User-Agent": SYNC_USER_AGENT },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

export async function runPool(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
  return results;
}

/**
 * Pure-Node ZIP archive reader using Central Directory (handles streaming data descriptors).
 * Supports compression methods 0 (stored) and 8 (deflate) with zero external packages.
 */
export function readZipEntries(buffer) {
  // Locate End of Central Directory (EOCD) signature 0x06054b50 from end of buffer.
  const minPos = Math.max(0, buffer.length - 65_557);
  let eocdOffset = -1;
  for (let pos = buffer.length - 22; pos >= minPos; pos--) {
    if (buffer.readUInt32LE(pos) === 0x06054b50) {
      eocdOffset = pos;
      break;
    }
  }
  if (eocdOffset < 0) throw new Error("Invalid ZIP archive: EOCD not found");

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = new Map();

  let offset = centralDirOffset;
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`Invalid ZIP central directory entry at ${offset}`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString("utf8");
    offset += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue;
    if (buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`Invalid ZIP local header for ${name}`);
    }
    const localNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const rawData = buffer.subarray(dataStart, dataStart + compressedSize);

    if (method === 0) {
      entries.set(name, rawData);
    } else if (method === 8) {
      entries.set(name, inflateRawSync(rawData));
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }
  }

  return entries;
}

function decodeXmlEntities(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

/**
 * Minimal XLSX sheet parser for standard Excel files (sharedStrings + inline/numeric cells).
 */
export function parseXlsxSheet(zipEntries, sheetPath) {
  const sstBuf = zipEntries.get("xl/sharedStrings.xml");
  const sharedStrings = [];
  if (sstBuf) {
    const sstXml = sstBuf.toString("utf8");
    for (const siMatch of sstXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      const pieces = [];
      for (const tMatch of siMatch[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
        pieces.push(decodeXmlEntities(tMatch[1]));
      }
      sharedStrings.push(pieces.join(""));
    }
  }

  const sheetBuf = zipEntries.get(sheetPath);
  if (!sheetBuf) throw new Error(`Missing worksheet ${sheetPath}`);
  const sheetXml = sheetBuf.toString("utf8");

  const rows = [];
  for (const rowMatch of sheetXml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const attrs = cellMatch[1];
      const inner = cellMatch[2];
      const refMatch = attrs.match(/\br="([A-Z]+)\d+"/);
      if (!refMatch) continue;
      const col = refMatch[1];
      const typeMatch = attrs.match(/\bt="([^"]+)"/);
      const cellType = typeMatch ? typeMatch[1] : "";

      if (cellType === "inlineStr") {
        const tPieces = [...inner.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((m) =>
          decodeXmlEntities(m[1]),
        );
        cells[col] = tPieces.join("");
      } else {
        const valMatch = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (!valMatch) continue;
        const raw = decodeXmlEntities(valMatch[1]);
        cells[col] = cellType === "s" ? (sharedStrings[Number(raw)] ?? "") : raw;
      }
    }
    rows.push(cells);
  }
  return rows;
}

export function stripUndefinedDeep(value) {
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripUndefinedDeep(item));
  }
  if (value !== null && typeof value === "object") {
    const cleaned = {};
    for (const [key, val] of Object.entries(value)) {
      if (val === undefined) continue;
      cleaned[key] = stripUndefinedDeep(val);
    }
    return cleaned;
  }
  return value;
}

export function assertFirestoreCompatible(value, fieldPath = "root", insideArray = false) {
  if (value === undefined) {
    throw new Error(`Firestore incompatible undefined value at "${fieldPath}"`);
  }
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`Firestore incompatible non-finite number at "${fieldPath}"`);
    }
    return;
  }
  if (Array.isArray(value)) {
    if (insideArray) {
      throw new Error(`Firestore incompatible nested array at "${fieldPath}"`);
    }
    for (let i = 0; i < value.length; i++) {
      assertFirestoreCompatible(value[i], `${fieldPath}[${i}]`, true);
    }
    return;
  }
  if (typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      assertFirestoreCompatible(val, `${fieldPath}.${key}`, false);
    }
    return;
  }
  throw new Error(`Firestore incompatible value type "${typeof value}" at "${fieldPath}"`);
}

export function shardByteSize(shard) {
  if (shard?.entriesGzip instanceof Uint8Array) {
    const { entriesGzip, ...meta } = shard;
    return Buffer.byteLength(JSON.stringify(meta), "utf8") + entriesGzip.byteLength;
  }
  return Buffer.byteLength(JSON.stringify(shard), "utf8");
}

export function shardEntryCount(shard) {
  if (typeof shard?.entryCount === "number") return shard.entryCount;
  if (Array.isArray(shard?.entries)) return shard.entries.length;
  return 0;
}

export function packSourceShards(sourceKey, defaults, entries, syncedAt) {
  const validatedDefaults = stripUndefinedDeep(sourceDefaultsSchema.parse(defaults));
  const validatedEntries = entries.map((entry) => {
    const clean = stripUndefinedDeep(compactEntrySchema.parse(entry));
    assertFirestoreCompatible(clean, `entry(${clean.id})`);
    return clean;
  });

  // Pack validated entries into gzip-compressed Firestore Bytes shards.
  // Gzip reduces ~5.4 MB of repetitive JSON to ~620 KB across ~5-6 docs and eliminates
  // per-field Firestore indexing overhead on the entries array.
  const buckets = [];
  let current = [];
  let currentRawBytes = 0;

  const flushBucket = () => {
    if (current.length === 0) return;
    // If a bucket's compressed size still exceeds MAX_SHARD_GZIP_BYTES, split in half.
    const queue = [current];
    while (queue.length > 0) {
      const slice = queue.shift();
      const gz = gzipSync(Buffer.from(JSON.stringify(slice), "utf8"), { level: 9 });
      if (gz.byteLength > MAX_SHARD_GZIP_BYTES && slice.length > 1) {
        const mid = Math.ceil(slice.length / 2);
        queue.unshift(slice.slice(0, mid), slice.slice(mid));
      } else {
        buckets.push({ entries: slice, gzip: gz });
      }
    }
    current = [];
    currentRawBytes = 0;
  };

  for (const entry of validatedEntries) {
    const entryBytes = Buffer.byteLength(JSON.stringify(entry), "utf8") + 2;
    if (entryBytes > MAX_SHARD_GZIP_BYTES) {
      throw new Error(`Single catalog entry "${entry.id}" exceeds shard budget (${entryBytes} bytes)`);
    }
    if (current.length > 0 && currentRawBytes + entryBytes > MAX_SHARD_JSON_BYTES) {
      flushBucket();
    }
    current.push(entry);
    currentRawBytes += entryBytes;
  }
  flushBucket();

  const shardCount = buckets.length;
  return buckets.map(({ entries: shardEntries, gzip }, shardIndex) => {
    const shard = stripUndefinedDeep(
      shardSchema.parse({
        schemaVersion: SHARD_SCHEMA_VERSION,
        sourceKey,
        shardIndex,
        shardCount,
        syncedAt,
        active: true,
        entryCount: shardEntries.length,
        defaults: validatedDefaults,
        entriesGzip: gzip,
      }),
    );
    assertFirestoreCompatible(shard, `${sourceKey}__shard_${shardIndex}`);
    const docBytes = shardByteSize(shard);
    if (docBytes > MAX_SHARD_DOC_BYTES) {
      throw new Error(
        `Packed shard ${sourceKey}__shard_${shardIndex} exceeds safe document size (${docBytes} > ${MAX_SHARD_DOC_BYTES} bytes)`,
      );
    }
    return shard;
  });
}

export function shardDocId(sourceKey, shardIndex) {
  return `${sourceKey}__shard_${String(shardIndex).padStart(3, "0")}`;
}

export function readFirebaseRcProject() {
  const rcPath = path.resolve(process.cwd(), ".firebaserc");
  if (!existsSync(rcPath)) return null;
  const rc = JSON.parse(readFileSync(rcPath, "utf8"));
  return typeof rc?.projects?.default === "string" && rc.projects.default.trim()
    ? rc.projects.default.trim()
    : null;
}

export function resolveProjectTarget(cliProject) {
  const rcProject = readFirebaseRcProject();
  if (cliProject) {
    return { projectId: cliProject, source: "--project", rcProject };
  }
  const envProject =
    process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || process.env.GCLOUD_PROJECT || null;
  const envSource = process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID
    ? "NEXT_PUBLIC_FIREBASE_PROJECT_ID"
    : process.env.GCLOUD_PROJECT
      ? "GCLOUD_PROJECT"
      : null;

  if (envProject) {
    if (rcProject && envProject !== rcProject && !process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error(
        `Refusing to write: ${envSource}="${envProject}" conflicts with .firebaserc default "${rcProject}". Pass --project ${envProject} explicitly to confirm.`,
      );
    }
    return { projectId: envProject, source: envSource, rcProject };
  }
  if (rcProject) {
    return { projectId: rcProject, source: ".firebaserc", rcProject };
  }
  throw new Error("Missing Firebase project ID. Pass --project <id> or set NEXT_PUBLIC_FIREBASE_PROJECT_ID.");
}

export function resolveProjectId(cliProject) {
  return resolveProjectTarget(cliProject).projectId;
}

export function getTargetFirestore(projectId) {
  const existing = getApps().find((app) => app.name === "kcalcue-catalog-sync");
  const app = existing ?? initializeApp(
    {
      projectId,
      credential: process.env.FIRESTORE_EMULATOR_HOST
        ? undefined
        : process.env.FIREBASE_ADMIN_CLIENT_EMAIL && process.env.FIREBASE_ADMIN_PRIVATE_KEY
          ? cert({
            projectId,
            clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
            privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY.replace(/\\n/g, "\n"),
          })
          : applicationDefault(),
    },
    "kcalcue-catalog-sync",
  );
  return getFirestore(app);
}

export async function applySourceShards(db, sourceKey, shards, syncedAt, options = {}) {
  const force = Boolean(options.force);
  if (!Array.isArray(shards) || shards.length === 0) {
    throw new Error(`Refusing to apply empty shard list for source "${sourceKey}".`);
  }
  const incomingEntries = shards.reduce((sum, shard) => sum + shardEntryCount(shard), 0);
  if (incomingEntries === 0) {
    throw new Error(`Refusing to apply 0 entries for source "${sourceKey}".`);
  }
  for (const shard of shards) {
    assertFirestoreCompatible(shard, `${sourceKey}__shard_${shard.shardIndex}`);
  }

  const collection = db.collection(SHARDS_COLLECTION);
  const existingSnap = await collection.where("sourceKey", "==", sourceKey).get();

  let existingActiveEntries = 0;
  for (const doc of existingSnap.docs) {
    const data = doc.data();
    if (data?.active !== false) {
      existingActiveEntries += shardEntryCount(data);
    }
  }
  if (!force && existingActiveEntries > 0 && incomingEntries < existingActiveEntries * 0.5) {
    throw new Error(
      `Refusing to apply source "${sourceKey}": entry count dropped sharply from ${existingActiveEntries} to ${incomingEntries} (>50% drop). Pass --force to override.`,
    );
  }

  const incomingIds = new Set(shards.map((shard) => shardDocId(sourceKey, shard.shardIndex)));
  const ops = [];
  for (const shard of shards) {
    const byteSize = shardByteSize(shard);
    ops.push({
      type: "set",
      ref: collection.doc(shardDocId(sourceKey, shard.shardIndex)),
      data: shard,
      byteSize,
    });
  }
  let deactivatedShards = 0;
  for (const doc of existingSnap.docs) {
    if (!incomingIds.has(doc.id)) {
      ops.push({
        type: "delete",
        ref: doc.ref,
        byteSize: 128,
      });
      deactivatedShards += 1;
    }
  }

  // Keep every single-source write atomic in one batch when under safe size/op limits
  // (all 5 current sources fit in 1 batch <= 1 MiB; split only if a future source grows huge).
  const BATCH_OP_LIMIT = 20;
  let currentBatchOps = [];
  let currentBatchBytes = 0;
  const batches = [];
  for (const op of ops) {
    if (
      currentBatchOps.length > 0 &&
      (currentBatchOps.length >= BATCH_OP_LIMIT || currentBatchBytes + op.byteSize > MAX_BATCH_BYTES)
    ) {
      batches.push(currentBatchOps);
      currentBatchOps = [];
      currentBatchBytes = 0;
    }
    currentBatchOps.push(op);
    currentBatchBytes += op.byteSize;
  }
  if (currentBatchOps.length > 0) batches.push(currentBatchOps);

  for (const chunk of batches) {
    const batch = db.batch();
    for (const op of chunk) {
      if (op.type === "set") batch.set(op.ref, op.data);
      else if (op.type === "delete") batch.delete(op.ref);
      else batch.update(op.ref, op.data);
    }
    await batch.commit();
  }

  return { upsertedShards: shards.length, deactivatedShards, batchesCommitted: batches.length };
}
