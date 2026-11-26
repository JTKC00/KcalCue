import { z } from "zod";
import { portionUnits, type PortionUnit } from "@/lib/domain/food-analysis";
import {
  blocksUsdaLiveLookup,
  canonicalizeFood,
  chocolateMilkName,
  contradictoryDairyMilkLabel,
  isCompositeIdentity,
  isUnsweetenedLemonTea,
  photoGenericMilkNeedsConfirmation,
  type MealPlantMilkContext,
} from "./canonical";
import { localNutritionProfiles } from "./local-data";
import type { ResolvableFood } from "./resolver";
import type {
  FoodCategory,
  FoodPreparation,
  NutrientRange,
  NutritionMatch,
  NutritionProfile,
} from "./types";

export const NUTRITION_CATALOG_SHARD_SCHEMA_VERSION = 2;
export const CATALOG_PROFILE_ID_PREFIX = "catalog:";
export const USDA_OFFLINE_SIMILARITY_THRESHOLD = 0.8;
export const PACKAGED_BRANDED_SIMILARITY_THRESHOLD = 0.72;

export const catalogSourceKinds = [
  "branded",
  "packaged_branded",
  "regional_hk",
  "regional_tw",
  "usda_offline",
] as const;
export type CatalogSourceKind = (typeof catalogSourceKinds)[number];

const categorySchema = z.enum([
  "rice", "noodles", "bread", "poultry", "beef", "pork", "seafood", "egg",
  "vegetable", "fruit", "tofu", "dairy", "sauce", "fried", "mixed", "unknown",
]);
const preparationSchema = z.enum([
  "raw", "cooked", "steamed", "boiled", "pan_fried", "grilled", "stir_fried",
  "deep_fried", "sauced", "unknown",
]);
const compactNutrientSchema = z.union([
  z.number().finite().nonnegative(),
  z.tuple([
    z.number().finite().nonnegative(),
    z.number().finite().nonnegative(),
  ]).refine(([min, max]) => max >= min, { message: "max must be >= min" }),
]);

export const catalogSourceDefaultsSchema = z.object({
  sourceKey: z.string().min(1).max(80),
  kind: z.enum(catalogSourceKinds),
  priority: z.number().int().min(1).max(1000),
  provider: z.literal("kcalcue-reference"),
  sourceLabel: z.string().min(1).max(120),
  attribution: z.string().min(1).max(400),
  dataNotice: z.string().min(1).max(400),
  brandAliases: z.array(z.string().min(1).max(80)).max(30),
  retrievedAt: z.string().min(1).max(32),
});
export type CatalogSourceDefaults = z.infer<typeof catalogSourceDefaultsSchema>;

export const compactCatalogEntrySchema = z.object({
  id: z.string().min(1).max(120),
  displayName: z.string().min(1).max(200),
  canonicalName: z.string().min(1).max(120),
  category: categorySchema,
  preparations: z.array(preparationSchema).min(1),
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
export type CompactCatalogEntry = z.infer<typeof compactCatalogEntrySchema>;

export const firestoreCatalogShardSchema = z.object({
  schemaVersion: z.literal(NUTRITION_CATALOG_SHARD_SCHEMA_VERSION),
  sourceKey: z.string().min(1).max(80),
  shardIndex: z.number().int().nonnegative(),
  shardCount: z.number().int().positive(),
  syncedAt: z.iso.datetime(),
  active: z.boolean(),
  defaults: catalogSourceDefaultsSchema,
  entries: z.array(compactCatalogEntrySchema),
});
export type FirestoreCatalogShard = z.infer<typeof firestoreCatalogShardSchema>;

export interface IndexedCatalogEntry {
  entry: CompactCatalogEntry;
  defaults: CatalogSourceDefaults;
  searchTokens?: Set<string>;
  packagedTokens?: Set<string>;
}

export interface CatalogIndex {
  entryCount: number;
  brandedBySource: Map<string, {
    defaults: CatalogSourceDefaults;
    exclusiveMap: Map<string, IndexedCatalogEntry[]>;
    brandedMap: Map<string, IndexedCatalogEntry[]>;
  }>;
  barcodeMap: Map<string, IndexedCatalogEntry>;
  packagedBrandIndex: Map<string, IndexedCatalogEntry[]>;
  regionalMap: Map<string, IndexedCatalogEntry[]>;
  usdaTokenIndex: Map<string, IndexedCatalogEntry[]>;
}

const DELIBERATELY_UNCALCULATED_DISH_IDS = new Set([
  "dressed-salad",
  "cream-macaroni",
  "cha-chaan-teng-set",
  "hotpot",
]);

const TRADEMARK_RE = /[®™©]/g;
const PUNCTUATION_RE = /[()（）[\]【】{}·•,，.。!！?？:：;；/／\\\-–—_'’"“”+&]+/g;
const LEADING_QUANTITY_RE = /^(?:(?:1|一)\s*(?:份|個|个|隻|只|件|杯|碗|盒|包|支|樽|瓶)\s*)+/u;
const LEADING_MULTI_COUNT_RE = /^(?:[2-9]\d*)\s*(?:件|隻|只|塊|块|pcs?)\s*/iu;
const TRAILING_MULTI_COUNT_RE = /\s*\(?(?:[2-9]\d*)\s*(?:件|隻|只|塊|块|pcs?)\)?$/iu;
const MULTI_PIECE_PACK_NAME_RE =
  /[（(][^）)]*[2-9]\d*\s*件[^）)]*[)）]|分享盒|拼盤|拼盘|sharing\s*box|platter|deluxe\s*breakfast|jumbo\s*breakfast/i;
const CJK_RE = /[\u3400-\u9fff]/;

const UNSWEETENED_QUALIFIER_RE =
  /無糖|无糖|走甜|走糖|零糖|0糖|(?:^|[^a-z0-9])(?:unsweetened|sugar\s*free|no\s*sugar|zero\s*sugar|zero)(?:$|[^a-z0-9])/i;
const LOW_SUGAR_QUALIFIER_RE =
  /低糖|少甜|少糖|微糖|減糖|减糖|(?:^|[^a-z0-9])(?:low\s*sugar|less\s*sugar|reduced\s*sugar|lite|light)(?:$|[^a-z0-9])/i;
const CHOCOLATE_TEXT_RE = /朱古力|巧克力|可可|(?:^|[^a-z0-9])(?:chocolate|cocoa|choco)(?:$|[^a-z0-9])/i;
const SOLID_CONFECTION_OR_SNACK_RE =
  /牛奶朱古力|牛奶巧克力|黑朱古力|黑巧克力|白朱古力|白巧克力|朱古力條|巧克力棒|朱古力餅|巧克力餅|薯片|洋芋片|餅乾|饼干|脆片|威化|糖果|蛋糕|麵包|面包|曲奇|(?:^|[^a-z0-9])(?:milk\s+chocolate|dark\s+chocolate|white\s+chocolate|chocolate\s+bar|chocolate\s+wafer|chocolate\s+biscuit|chocolate\s+cookie|potato\s+chips|crisps|biscuits?|cookies?|crackers?|cand(?:y|ies)|cake|bread|noodles?|pasta)(?:$|[^a-z0-9])/i;
const EXPLICIT_BEVERAGE_CUE_RE =
  /飲品|飲料|饮料|豆奶|豆漿|豆浆|鮮奶|鮮乳|鲜奶|鲜乳|牛奶|牛乳|燕麥奶|燕麦奶|杏仁奶|朱古力奶|巧克力奶|奶茶|檸茶|檸檬茶|茶飲|果汁|汽水|可樂|咖啡|拿鐵|礦泉水|(?:^|[^a-z0-9])(?:drink|beverage|tea|juice|soda|cola|coffee|latte|water|chocolate\s+milk|soy\s*milk|soya|oat\s*milk|almond\s*milk|fresh\s*milk|whole\s*milk|skim\s*milk|low\s*fat\s*milk)(?:$|[^a-z0-9])/i;
const PLANT_MILK_TEXT_RE =
  /豆奶|豆漿|豆浆|燕麥奶|燕麦奶|杏仁奶|椰奶|米奶|植物奶|(?:^|[^a-z0-9])(?:soy\s*milk|soya|oat\s*milk|almond\s*milk|coconut\s*milk|plant\s*milk)(?:$|[^a-z0-9])/i;
const DAIRY_MILK_TEXT_RE =
  /鮮奶|鮮乳|鲜奶|鲜乳|牛奶|牛乳|全脂奶|低脂奶|脫脂奶|脱脂奶|(?:^|[^a-z0-9])(?:fresh\s*milk|whole\s*milk|cow\s*milk|dairy\s*milk|skim\s*milk|low\s*fat\s*milk)(?:$|[^a-z0-9])/i;

let cachedLocalProfileKeys: Set<string> | null = null;
function exactCuratedLocalKeys(): Set<string> {
  if (!cachedLocalProfileKeys) {
    cachedLocalProfileKeys = new Set(
      localNutritionProfiles.flatMap((profile) =>
        [profile.id, profile.displayName, profile.canonicalName, ...profile.aliases]
          .map(normalizeCatalogKey)
          .filter(Boolean),
      ),
    );
  }
  return cachedLocalProfileKeys;
}

function isExactCuratedLocalName(
  food: Pick<ResolvableFood, "displayName" | "normalizedName">,
): boolean {
  const keys = exactCuratedLocalKeys();
  const display = normalizeCatalogKey(food.displayName);
  const normalized = normalizeCatalogKey(food.normalizedName);
  if (display) return keys.has(display);
  return Boolean(normalized) && keys.has(normalized);
}

const USDA_FILLER_WORDS = new Set([
  "a", "added", "all", "and", "baked", "boiled", "chopped", "commercial",
  "commercially", "cooked", "diced", "dried", "dry", "eat", "fresh", "frozen",
  "fortified", "grilled", "heat", "in", "low", "fat", "flesh", "of", "pan",
  "peeled", "plain", "percent", "prepared", "raw", "ready", "reduced",
  "roasted", "salt", "seared", "sliced", "steamed", "skin", "seed", "seeds",
  "species", "the", "to", "uncooked", "unpeeled", "unprepared", "variety",
  "vitamin", "water", "with", "without", "whole", "milkfat", "nsf", "ns",
  "nfs", "only", "meat", "separable", "lean", "trimmed", "broilers", "fryers",
  "mature", "mixed", "solids", "liquids", "drained", "salted", "unsalted",
  "regular",
]);

const USDA_TAXONOMY_PREFIX_RE =
  /^(?:mollusks|crustaceans|fish|finfish|nuts|seeds|spices|game meat),\s+/i;
const USDA_HABITAT_QUALIFIER_RE = /\(\s*bay and sea\s*\)/gi;

function expandNutrient(value: number | [number, number]): NutrientRange {
  return Array.isArray(value)
    ? { min: value[0], max: value[1] }
    : { min: value, max: value };
}

export function materializeNutritionProfile(
  entry: CompactCatalogEntry,
  defaults: CatalogSourceDefaults,
): NutritionProfile {
  const aliases = [
    ...(entry.exclusiveAliases ?? []),
    ...(entry.brandedAliases ?? []),
  ];
  return {
    id: `${CATALOG_PROFILE_ID_PREFIX}${entry.id}`,
    displayName: entry.displayName,
    canonicalName: entry.canonicalName,
    category: entry.category as FoodCategory,
    preparations: entry.preparations as FoodPreparation[],
    aliases,
    composite: entry.composite,
    nutrientsPer100g: {
      calories: expandNutrient(entry.kcal),
      protein: expandNutrient(entry.protein),
      carbs: expandNutrient(entry.carbs),
      fat: expandNutrient(entry.fat),
    },
    gramsPerUnit: entry.gramsPerUnit as Partial<Record<PortionUnit, number>>,
    source: {
      provider: defaults.provider,
      sourceId: entry.sourceId,
      sourceName: entry.sourceName ?? `${defaults.sourceLabel}：${entry.displayName}`,
      retrievedAt: defaults.retrievedAt,
      attribution: defaults.attribution,
    },
    dataNotice: defaults.dataNotice,
    densityBasis: entry.densityBasis,
  };
}

export function normalizeCatalogKey(value: string): string {
  return value
    .normalize("NFKC")
    .replace(TRADEMARK_RE, "")
    .toLocaleLowerCase("en")
    .replace(PUNCTUATION_RE, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactCjkKey(normalized: string): string {
  return CJK_RE.test(normalized) ? normalized.replace(/\s+/g, "") : normalized;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAsciiToken(value: string): boolean {
  return /^[a-z0-9\s]+$/.test(value);
}

function containsBrandAlias(normalizedText: string, normalizedAlias: string): boolean {
  if (!normalizedText || !normalizedAlias) return false;
  if (isAsciiToken(normalizedAlias)) {
    return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(normalizedAlias)}(?:$|[^a-z0-9])`).test(normalizedText);
  }
  if (/^[a-z0-9]/.test(normalizedAlias)) {
    return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(normalizedAlias)}`).test(normalizedText);
  }
  return normalizedText.includes(normalizedAlias);
}

export function hasCatalogBrandCue(
  food: Pick<ResolvableFood, "displayName" | "normalizedName" | "notes">,
  brandAliases: readonly string[],
): boolean {
  if (brandAliases.length === 0) return false;
  // Brand cues must come from THIS food item itself (displayName, normalizedName, or item notes),
  // never meal-level journal notes or visibleEvidence about other dishes in the same meal.
  const haystack = [
    food.displayName,
    food.normalizedName,
    food.notes ?? "",
  ]
    .map(normalizeCatalogKey)
    .filter(Boolean);

  if (haystack.length === 0) return false;

  const normalizedAliases = brandAliases
    .map(normalizeCatalogKey)
    .filter(Boolean);

  return haystack.some((text) =>
    normalizedAliases.some((alias) => containsBrandAlias(text, alias)),
  );
}

export function stripBrandAliases(text: string, brandAliases: readonly string[]): string {
  let result = normalizeCatalogKey(text);
  if (!result) return "";

  const sorted = [...brandAliases]
    .map(normalizeCatalogKey)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  for (const alias of sorted) {
    if (isAsciiToken(alias)) {
      result = result.replace(
        new RegExp(`(?:^|(?<=[^a-z0-9]))${escapeRegExp(alias)}(?:$|(?=[^a-z0-9]))`, "g"),
        " ",
      );
    } else if (/^[a-z0-9]/.test(alias)) {
      result = result.replace(
        new RegExp(`(?:^|(?<=[^a-z0-9]))${escapeRegExp(alias)}`, "g"),
        " ",
      );
    } else {
      result = result.replaceAll(alias, " ");
    }
  }

  return result
    .replace(/\s+/g, " ")
    .trim()
    .replace(LEADING_QUANTITY_RE, "")
    .trim();
}

function candidateKeys(
  text: string,
  brandAliases: readonly string[] = [],
  stripMultiCount = false,
): string[] {
  const keys = new Set<string>();
  const addVariants = (value: string) => {
    if (!value) return;
    keys.add(value);
    keys.add(compactCjkKey(value));
    if (stripMultiCount) {
      const strippedCount = value
        .replace(LEADING_MULTI_COUNT_RE, "")
        .replace(TRAILING_MULTI_COUNT_RE, "")
        .trim();
      if (strippedCount && strippedCount !== value) {
        keys.add(strippedCount);
        keys.add(compactCjkKey(strippedCount));
      }
    }
  };
  const raw = normalizeCatalogKey(text);
  if (raw) {
    addVariants(raw);
    const withoutQty = raw.replace(LEADING_QUANTITY_RE, "").trim();
    if (withoutQty) addVariants(withoutQty);
  }
  if (brandAliases.length > 0) {
    const stripped = stripBrandAliases(text, brandAliases);
    if (stripped) addVariants(stripped);
  }
  return [...keys];
}

function addToKeyMap(
  map: Map<string, IndexedCatalogEntry[]>,
  aliases: readonly string[] | undefined,
  item: IndexedCatalogEntry,
): void {
  if (!aliases) return;
  for (const alias of aliases) {
    const normalized = normalizeCatalogKey(alias);
    if (!normalized) continue;
    const keys = [normalized];
    const compact = compactCjkKey(normalized);
    if (compact !== normalized) keys.push(compact);
    for (const key of keys) {
      const bucket = map.get(key);
      if (bucket) {
        if (!bucket.includes(item)) bucket.push(item);
      } else {
        map.set(key, [item]);
      }
    }
  }
}

function singularizeWord(word: string): string {
  if (word.length > 4 && word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (word.length > 4 && /(?:ches|shes|xes|zes|ses)$/.test(word)) return word.slice(0, -2);
  if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss") && !word.endsWith("us")) {
    return word.slice(0, -1);
  }
  return word;
}

export function tokenizeUsdaText(value: string, isDescription = false): Set<string> {
  const prepared = isDescription
    ? value.replace(USDA_TAXONOMY_PREFIX_RE, "").replace(USDA_HABITAT_QUALIFIER_RE, " ")
    : value;
  const normalized = normalizeCatalogKey(prepared);
  const tokens = new Set<string>();
  for (const raw of normalized.split(" ")) {
    if (!raw || raw.length < 2 || !/^[a-z0-9]+$/.test(raw)) continue;
    if (USDA_FILLER_WORDS.has(raw)) continue;
    const singular = singularizeWord(raw);
    if (singular.length >= 2 && !USDA_FILLER_WORDS.has(singular)) {
      tokens.add(singular);
    }
  }
  return tokens;
}

const BARCODE_RE = /(?:^|[^0-9])(\d{8,14})(?:$|[^0-9])/g;
const PACKAGED_STOP_WORDS = new Set([
  "the", "and", "with", "for", "of", "in", "by", "flavour", "flavor", "style",
  "drink", "beverage", "food", "product", "original", "classic", "ml", "g", "kg", "l",
]);

function tokenizePackagedText(value: string): Set<string> {
  const normalized = normalizeCatalogKey(value);
  const tokens = new Set<string>();
  if (!normalized) return tokens;

  for (const part of normalized.split(" ")) {
    if (!part) continue;
    if (/^[a-z0-9]+$/.test(part)) {
      if (part.length < 2 || /^\d+$/.test(part) || PACKAGED_STOP_WORDS.has(part)) continue;
      const singular = singularizeWord(part);
      if (singular.length >= 2 && !PACKAGED_STOP_WORDS.has(singular)) tokens.add(singular);
      continue;
    }
    const cjkChars = [...part].filter((ch) => CJK_RE.test(ch));
    if (cjkChars.length === 1) {
      tokens.add(cjkChars[0]!);
    } else {
      for (let i = 0; i < cjkChars.length - 1; i++) {
        tokens.add(cjkChars[i]! + cjkChars[i + 1]!);
      }
    }
  }
  return tokens;
}

export function emptyCatalogIndex(): CatalogIndex {
  return {
    entryCount: 0,
    brandedBySource: new Map(),
    barcodeMap: new Map(),
    packagedBrandIndex: new Map(),
    regionalMap: new Map(),
    usdaTokenIndex: new Map(),
  };
}

export function buildCatalogIndex(shards: readonly FirestoreCatalogShard[]): CatalogIndex {
  const index = emptyCatalogIndex();

  for (const shard of shards) {
    if (!shard.active) continue;
    const { defaults, entries } = shard;

    if (defaults.kind === "branded") {
      let bucket = index.brandedBySource.get(defaults.sourceKey);
      if (!bucket) {
        bucket = {
          defaults,
          exclusiveMap: new Map(),
          brandedMap: new Map(),
        };
        index.brandedBySource.set(defaults.sourceKey, bucket);
      }
      for (const entry of entries) {
        const item: IndexedCatalogEntry = { entry, defaults };
        addToKeyMap(bucket.exclusiveMap, entry.exclusiveAliases, item);
        addToKeyMap(bucket.brandedMap, entry.brandedAliases, item);
        index.entryCount += 1;
      }
      continue;
    }

    if (defaults.kind === "packaged_branded") {
      for (const entry of entries) {
        const brandAliases = entry.itemBrandAliases ?? [];
        const rawText = entry.searchText ?? entry.displayName;
        const stripped = brandAliases.length > 0 ? stripBrandAliases(rawText, brandAliases) : rawText;
        const packagedTokens = tokenizePackagedText(stripped || rawText);
        const item: IndexedCatalogEntry = { entry, defaults, packagedTokens };
        if (entry.barcode && !index.barcodeMap.has(entry.barcode)) {
          index.barcodeMap.set(entry.barcode, item);
        }
        for (const alias of brandAliases) {
          const normalizedBrand = normalizeCatalogKey(alias);
          if (!normalizedBrand || normalizedBrand.length < 2) continue;
          const keys = [normalizedBrand];
          const compact = compactCjkKey(normalizedBrand);
          if (compact !== normalizedBrand) keys.push(compact);
          for (const key of keys) {
            const list = index.packagedBrandIndex.get(key);
            if (list) {
              if (!list.includes(item)) list.push(item);
            } else {
              index.packagedBrandIndex.set(key, [item]);
            }
          }
        }
        index.entryCount += 1;
      }
      continue;
    }

    if (defaults.kind === "regional_hk" || defaults.kind === "regional_tw") {
      for (const entry of entries) {
        const item: IndexedCatalogEntry = { entry, defaults };
        addToKeyMap(index.regionalMap, entry.exclusiveAliases, item);
        index.entryCount += 1;
      }
      continue;
    }

    if (defaults.kind === "usda_offline") {
      for (const entry of entries) {
        const searchText = entry.searchText ?? entry.displayName;
        const tokens = tokenizeUsdaText(searchText, true);
        if (tokens.size === 0) continue;
        const item: IndexedCatalogEntry = { entry, defaults, searchTokens: tokens };
        for (const token of tokens) {
          const list = index.usdaTokenIndex.get(token);
          if (list) list.push(item);
          else index.usdaTokenIndex.set(token, [item]);
        }
        index.entryCount += 1;
      }
    }
  }

  return index;
}

function kcalMidpoint(value: number | [number, number]): number {
  return Array.isArray(value) ? (value[0] + value[1]) / 2 : value;
}

function preparationCompatibleForCatalog(
  requested: FoodPreparation,
  entryPreps: readonly FoodPreparation[],
): boolean {
  if (requested === "unknown") return true;
  if (requested === "raw") {
    return entryPreps.includes("raw");
  }
  if (requested === "deep_fried") {
    return entryPreps.includes("deep_fried");
  }
  // Explicit cooked/prepared request must never fall back onto a strictly raw-only entry
  // (e.g. "Cooked Kumquats" -> "Kumquats, raw") or a strictly deep-fried entry.
  if (entryPreps.every((prep) => prep === "raw")) return false;
  if (entryPreps.every((prep) => prep === "deep_fried")) return false;
  return true;
}

function entryDescriptorText(entry: CompactCatalogEntry): string {
  return normalizeCatalogKey(
    [
      entry.displayName,
      entry.searchText ?? "",
      ...(entry.exclusiveAliases ?? []),
      ...(entry.brandedAliases ?? []),
    ].join(" "),
  );
}

function hasSemanticConflict(
  food: ResolvableFood,
  entry: CompactCatalogEntry,
  options: { isBarcodeMatch?: boolean } = {},
): boolean {
  const foodNameText = normalizeCatalogKey(`${food.displayName} ${food.normalizedName}`);
  const foodAllText = normalizeCatalogKey(`${food.displayName} ${food.normalizedName} ${food.notes ?? ""}`);
  const strippedBarcodeName = foodNameText.replace(BARCODE_RE, " ").replace(/\s+/g, " ").trim();
  const isPureBarcodeQuery = Boolean(options.isBarcodeMatch) && strippedBarcodeName.length === 0;
  if (isPureBarcodeQuery) return false;

  const entryText = entryDescriptorText(entry);

  if (isUnsweetenedLemonTea(food)) {
    if (!UNSWEETENED_QUALIFIER_RE.test(entryText) || kcalMidpoint(entry.kcal) > 10) {
      return true;
    }
  }

  if (chocolateMilkName(food) && !CHOCOLATE_TEXT_RE.test(entryText)) {
    return true;
  }

  const queryUnsweetened = UNSWEETENED_QUALIFIER_RE.test(foodAllText);
  const entryUnsweetened = UNSWEETENED_QUALIFIER_RE.test(entryText);
  if (queryUnsweetened && !entryUnsweetened) return true;
  if (!options.isBarcodeMatch && !queryUnsweetened && entryUnsweetened) return true;

  const queryLowSugar = LOW_SUGAR_QUALIFIER_RE.test(foodAllText);
  const entryLowSugar = LOW_SUGAR_QUALIFIER_RE.test(entryText);
  if (queryLowSugar && !entryLowSugar) return true;
  if (!options.isBarcodeMatch && !queryLowSugar && entryLowSugar) return true;

  const queryPlantMilk = PLANT_MILK_TEXT_RE.test(foodAllText);
  const queryDairyMilk = DAIRY_MILK_TEXT_RE.test(foodAllText) && !queryPlantMilk;
  const entryPlantMilk = PLANT_MILK_TEXT_RE.test(entryText);
  const entryDairyMilk = DAIRY_MILK_TEXT_RE.test(entryText) && !entryPlantMilk;
  if (queryPlantMilk && entryDairyMilk) return true;
  if (queryDairyMilk && entryPlantMilk) return true;

  // Product-type safety: prevent solid confections/snacks (e.g. "Vita Milk Chocolate") from
  // matching liquid beverages (e.g. "Vita Chocolate Milk") via bag-of-words overlap, and vice versa.
  const querySolidConfection =
    SOLID_CONFECTION_OR_SNACK_RE.test(foodAllText) && !EXPLICIT_BEVERAGE_CUE_RE.test(foodAllText);
  const entrySolidConfection =
    SOLID_CONFECTION_OR_SNACK_RE.test(entryText) && !entry.gramsPerUnit.ml;
  const entryIsLiquidBeverage =
    Boolean(entry.gramsPerUnit.ml) ||
    (EXPLICIT_BEVERAGE_CUE_RE.test(entryText) && !SOLID_CONFECTION_OR_SNACK_RE.test(entryText));
  const queryIsLiquidBeverage =
    food.unit === "ml" ||
    (EXPLICIT_BEVERAGE_CUE_RE.test(foodNameText) && !SOLID_CONFECTION_OR_SNACK_RE.test(foodNameText));
  if (querySolidConfection && entryIsLiquidBeverage) return true;
  if (queryIsLiquidBeverage && entrySolidConfection) return true;

  return false;
}

function preparationBonus(
  requested: FoodPreparation,
  entryPreps: readonly FoodPreparation[],
): number {
  if (requested === "raw") {
    return entryPreps.includes("raw") ? 15 : -10;
  }
  if (requested !== "unknown") {
    if (entryPreps.includes(requested)) return 15;
    if (entryPreps.includes("cooked")) return 5;
    if (entryPreps.includes("raw")) return -8;
    return 0;
  }
  // When user didn't specify raw vs cooked, slightly prefer cooked/ready-to-eat over raw.
  if (entryPreps.includes("cooked") || entryPreps.includes("boiled") || entryPreps.includes("steamed")) {
    return 4;
  }
  return 0;
}

function finalizeCatalogMatch(
  food: ResolvableFood,
  item: IndexedCatalogEntry,
  identity: ReturnType<typeof canonicalizeFood>,
  matchType: NutritionMatch["matchType"],
  confidence: NutritionMatch["confidence"],
  reason: string,
): NutritionMatch {
  const profile = materializeNutritionProfile(item.entry, item.defaults);
  const gramsPerUnit = profile.gramsPerUnit[food.unit];
  if (typeof gramsPerUnit !== "number" || !Number.isFinite(gramsPerUnit) || gramsPerUnit <= 0) {
    return {
      profile: null,
      confidence: "low",
      matchType: "unresolved",
      reasons: [`未有 ${food.unit} 的可靠克重換算，因此不納入總數。`],
      identity,
      includedInTotal: false,
      coverageReason: "UNIT_CONVERSION_MISSING",
    };
  }
  return {
    profile,
    confidence,
    matchType,
    reasons: [reason],
    identity,
    includedInTotal: true,
  };
}

function resolveBranded(
  food: ResolvableFood,
  index: CatalogIndex,
  identity: ReturnType<typeof canonicalizeFood>,
): NutritionMatch | null {
  if (index.brandedBySource.size === 0) return null;

  const isMultiPieceQuery = food.unit === "piece" && food.portionMax > 1;
  const hitScores = new Map<string, { item: IndexedCatalogEntry; score: number }>();

  const recordHit = (item: IndexedCatalogEntry, score: number) => {
    // When the user specifies > 1 piece (e.g. "6件麥樂雞" + 6 piece, or "滋味分享盒" + 10 piece),
    // never multiply a whole multi-piece box/platter by the count — let single-piece entries win
    // or leave unresolved instead of fabricating a 10x sharing box total.
    if (isMultiPieceQuery && MULTI_PIECE_PACK_NAME_RE.test(item.entry.displayName)) {
      return;
    }
    if (hasSemanticConflict(food, item.entry)) return;
    const unitBonus = item.entry.gramsPerUnit[food.unit] ? 8 : 0;
    const total = score + unitBonus;
    const existing = hitScores.get(item.entry.id);
    if (!existing || total > existing.score) {
      hitScores.set(item.entry.id, { item, score: total });
    }
  };

  for (const bucket of index.brandedBySource.values()) {
    const { defaults, exclusiveMap, brandedMap } = bucket;
    const brandCue = hasCatalogBrandCue(food, defaults.brandAliases);
    const displayKeys = candidateKeys(food.displayName, defaults.brandAliases, isMultiPieceQuery);
    const normalizedKeys = candidateKeys(food.normalizedName, defaults.brandAliases, isMultiPieceQuery);

    for (const [keys, displayBonus] of [[displayKeys, 5], [normalizedKeys, 0]] as const) {
      for (const key of keys) {
        for (const item of exclusiveMap.get(key) ?? []) {
          recordHit(item, defaults.priority + (brandCue ? 20 : 0) + displayBonus);
        }
        if (brandCue) {
          for (const item of brandedMap.get(key) ?? []) {
            recordHit(item, defaults.priority - 10 + displayBonus);
          }
        }
      }
    }
  }

  const hits = [...hitScores.values()];
  if (hits.length === 0) return null;
  hits.sort((left, right) => right.score - left.score);
  const best = hits[0]!;
  const second = hits[1];
  if (second && second.score === best.score && second.item.entry.id !== best.item.entry.id) {
    return {
      profile: null,
      confidence: "low",
      matchType: "unresolved",
      reasons: ["找到多個相近但不相同的品牌營養資料，為免假裝精準，暫不自動配對。"],
      identity,
      includedInTotal: false,
      coverageReason: "AMBIGUOUS_MATCH",
    };
  }

  const sourceName =
    best.item.entry.sourceName ?? `${best.item.defaults.sourceLabel}：${best.item.entry.displayName}`;
  return finalizeCatalogMatch(
    food,
    best.item,
    identity,
    "exact_canonical",
    "high",
    `名稱與 ${sourceName} 一致。`,
  );
}

function isExactLocalMatch(
  food: Pick<ResolvableFood, "displayName" | "normalizedName">,
  localMatch: NutritionMatch | null | undefined,
): boolean {
  if (!localMatch?.includedInTotal || !localMatch.profile) return false;
  const profileKeys = new Set(
    [
      localMatch.profile.id,
      localMatch.profile.displayName,
      localMatch.profile.canonicalName,
      ...localMatch.profile.aliases,
    ]
      .map(normalizeCatalogKey)
      .filter(Boolean),
  );
  const display = normalizeCatalogKey(food.displayName);
  const normalized = normalizeCatalogKey(food.normalizedName);
  if (display) return profileKeys.has(display);
  return Boolean(normalized) && profileKeys.has(normalized);
}

function resolveRegional(
  food: ResolvableFood,
  index: CatalogIndex,
  identity: ReturnType<typeof canonicalizeFood>,
  allowedKinds?: ReadonlySet<CatalogSourceKind>,
): NutritionMatch | null {
  if (index.regionalMap.size === 0) return null;
  const compositeFood = isCompositeIdentity(identity);

  const keys = [
    ...candidateKeys(food.displayName),
    ...candidateKeys(food.normalizedName),
  ];
  const seen = new Set<string>();
  const hits: Array<{ item: IndexedCatalogEntry; score: number }> = [];

  for (const key of keys) {
    for (const item of index.regionalMap.get(key) ?? []) {
      if (seen.has(item.entry.id)) continue;
      if (allowedKinds && !allowedKinds.has(item.defaults.kind)) continue;
      // Composite dish safety: never match a composite dish onto a single non-composite ingredient.
      if (compositeFood && !item.entry.composite) continue;
      if (!preparationCompatibleForCatalog(identity.preparation, item.entry.preparations)) continue;
      if (hasSemanticConflict(food, item.entry)) continue;
      seen.add(item.entry.id);
      const prepScore = preparationBonus(identity.preparation, item.entry.preparations);
      const unitBonus = item.entry.gramsPerUnit[food.unit] ? 10 : 0;
      hits.push({
        item,
        score: item.defaults.priority * 10 + prepScore + unitBonus,
      });
    }
  }

  if (hits.length === 0) return null;
  hits.sort((left, right) => right.score - left.score);
  const best = hits[0]!;
  const second = hits[1];

  if (
    second &&
    second.score === best.score &&
    second.item.defaults.sourceKey === best.item.defaults.sourceKey
  ) {
    const a = kcalMidpoint(best.item.entry.kcal);
    const b = kcalMidpoint(second.item.entry.kcal);
    const maxVal = Math.max(a, b);
    const minVal = Math.min(a, b);
    if (maxVal > 0 && (minVal === 0 || maxVal / minVal > 1.25)) {
      return {
        profile: null,
        confidence: "low",
        matchType: "unresolved",
        reasons: ["找到多個相近但不相同的參考營養資料，為免假裝精準，暫不自動配對。"],
        identity,
        includedInTotal: false,
        coverageReason: "AMBIGUOUS_MATCH",
      };
    }
  }

  const isHk = best.item.defaults.kind === "regional_hk";
  const confidence: NutritionMatch["confidence"] =
    isHk && !best.item.entry.composite ? "high" : "medium";
  const matchType: NutritionMatch["matchType"] = isHk ? "exact_canonical" : "strong_synonym";
  const sourceName =
    best.item.entry.sourceName ?? `${best.item.defaults.sourceLabel}：${best.item.entry.displayName}`;

  return finalizeCatalogMatch(
    food,
    best.item,
    identity,
    matchType,
    confidence,
    isHk
      ? `已對應 ${sourceName}（香港食安中心化驗參考）。`
      : `已對應 ${sourceName}（台灣食藥署營養成分參考）。`,
  );
}

function resolveUsdaOffline(
  food: ResolvableFood,
  index: CatalogIndex,
  identity: ReturnType<typeof canonicalizeFood>,
  mealContext?: MealPlantMilkContext,
): NutritionMatch | null {
  if (index.usdaTokenIndex.size === 0) return null;
  if (isCompositeIdentity(identity)) return null;
  if (blocksUsdaLiveLookup(food, mealContext)) return null;

  const queryTokens = tokenizeUsdaText(`${food.normalizedName} ${food.displayName}`);
  if (queryTokens.size === 0) return null;

  const candidateCounts = new Map<IndexedCatalogEntry, number>();
  for (const token of queryTokens) {
    const posting = index.usdaTokenIndex.get(token);
    if (!posting) continue;
    for (const item of posting) {
      candidateCounts.set(item, (candidateCounts.get(item) ?? 0) + 1);
    }
  }
  if (candidateCounts.size === 0) return null;

  let bestItem: IndexedCatalogEntry | null = null;
  let bestScore = -1;

  for (const [item, overlap] of candidateCounts) {
    const entryTokens = item.searchTokens;
    if (!entryTokens || entryTokens.size === 0) continue;
    // Mirror USDA live client's conservative Dice/overlap threshold (>= 0.8)
    const similarity = (2 * overlap) / (queryTokens.size + entryTokens.size);
    const exactQueryCoverage = overlap === queryTokens.size;
    if (similarity < USDA_OFFLINE_SIMILARITY_THRESHOLD) continue;
    // Only consider items that actually support the requested unit and compatible preparation.
    if (!item.entry.gramsPerUnit[food.unit]) continue;
    if (!preparationCompatibleForCatalog(identity.preparation, item.entry.preparations)) continue;
    if (hasSemanticConflict(food, item.entry)) continue;

    const isFoundation = item.entry.sourceId.startsWith("usda-foundation:");
    const prepScore = preparationBonus(identity.preparation, item.entry.preparations);
    const totalScore =
      similarity * 100 +
      (exactQueryCoverage ? 10 : 0) +
      (isFoundation ? 3 : 0) +
      prepScore * 0.25;

    if (totalScore > bestScore) {
      bestScore = totalScore;
      bestItem = item;
    }
  }

  if (!bestItem) return null;

  return finalizeCatalogMatch(
    food,
    bestItem,
    identity,
    "approximate_generic",
    "medium",
    "已從離線 USDA FoodData Central 參考庫找到通用食物資料，烹調細節仍然未知。",
  );
}

function extractBarcodes(
  food: Pick<ResolvableFood, "displayName" | "normalizedName" | "notes">,
): string[] {
  const text = `${food.displayName} ${food.normalizedName} ${food.notes ?? ""}`;
  const codes = new Set<string>();
  for (const match of text.matchAll(BARCODE_RE)) {
    if (match[1]) codes.add(match[1]);
  }
  return [...codes];
}

function resolvePackagedBranded(
  food: ResolvableFood,
  index: CatalogIndex,
  identity: ReturnType<typeof canonicalizeFood>,
  localMatch: NutritionMatch | null | undefined,
): NutritionMatch | null {
  if (index.barcodeMap.size === 0 && index.packagedBrandIndex.size === 0) return null;

  // Path 1: Exact barcode match (EAN-8 / EAN-13 / UPC), still verified against food text conflicts.
  for (const code of extractBarcodes(food)) {
    const hit = index.barcodeMap.get(code);
    if (hit) {
      if (hasSemanticConflict(food, hit.entry, { isBarcodeMatch: true })) continue;
      const sourceName =
        hit.entry.sourceName ?? `${hit.defaults.sourceLabel}：${hit.entry.displayName}`;
      return finalizeCatalogMatch(
        food,
        hit,
        identity,
        "exact_canonical",
        "high",
        `條碼與 ${sourceName} 一致。`,
      );
    }
  }

  // Path 2: Brand + product name match — brand cue MUST come from THIS food item itself
  // (never meal-level notes/visibleEvidence) so another branded item in the same meal never
  // causes cross-item leakage onto an unbranded food.
  const itemBrandStrings = [
    food.displayName,
    food.normalizedName,
    food.notes ?? "",
  ]
    .map(normalizeCatalogKey)
    .filter(Boolean);
  if (itemBrandStrings.length === 0) return null;

  const candidates = new Set<IndexedCatalogEntry>();
  for (const [brandKey, list] of index.packagedBrandIndex) {
    if (itemBrandStrings.some((text) => containsBrandAlias(text, brandKey))) {
      for (const item of list) candidates.add(item);
    }
  }
  if (candidates.size === 0) return null;

  const scored: Array<{ item: IndexedCatalogEntry; score: number }> = [];
  for (const item of candidates) {
    if (hasSemanticConflict(food, item.entry)) continue;
    const brandAliases = item.entry.itemBrandAliases ?? [];
    const queryDisplay = stripBrandAliases(food.displayName, brandAliases);
    const queryNorm = stripBrandAliases(food.normalizedName, brandAliases);
    const entryNames = [
      ...(item.entry.brandedAliases ?? []),
      item.entry.displayName,
    ]
      .map((alias) => stripBrandAliases(alias, brandAliases))
      .filter(Boolean);

    let similarity = 0;
    const exactQueryKeys = new Set(
      [queryDisplay, queryNorm, compactCjkKey(queryDisplay), compactCjkKey(queryNorm)].filter(
        (k) => k.length >= 2,
      ),
    );
    const exactEntryKeys = new Set(
      entryNames.flatMap((n) => [n, compactCjkKey(n)]).filter((k) => k.length >= 2),
    );

    if (exactQueryKeys.size > 0 && [...exactQueryKeys].some((k) => exactEntryKeys.has(k))) {
      similarity = 1;
    } else {
      const queryTokens = tokenizePackagedText(`${queryDisplay} ${queryNorm}`);
      const entryTokens = item.packagedTokens;
      if (queryTokens.size > 0 && entryTokens && entryTokens.size > 0) {
        let overlap = 0;
        for (const token of queryTokens) {
          if (entryTokens.has(token)) overlap += 1;
        }
        if (overlap >= 2 || (overlap === 1 && queryTokens.size === 1 && entryTokens.size === 1)) {
          similarity = (2 * overlap) / (queryTokens.size + entryTokens.size);
        }
      }
    }

    if (similarity >= PACKAGED_BRANDED_SIMILARITY_THRESHOLD) {
      const unitBonus = item.entry.gramsPerUnit[food.unit] ? 0.02 : 0;
      scored.push({ item, score: similarity + unitBonus });
    }
  }

  if (scored.length === 0) return null;
  scored.sort((left, right) => right.score - left.score);
  const best = scored[0]!;
  const second = scored[1];
  if (second && best.score - second.score < 0.05) {
    const a = kcalMidpoint(best.item.entry.kcal);
    const b = kcalMidpoint(second.item.entry.kcal);
    const maxVal = Math.max(a, b);
    const minVal = Math.min(a, b);
    if (maxVal > 0 && (minVal === 0 || maxVal / minVal > 1.2)) {
      if (localMatch?.includedInTotal) return null;
      return {
        profile: null,
        confidence: "low",
        matchType: "unresolved",
        reasons: ["找到同品牌多款熱量差異較大的包裝產品，請補充口味或糖分說明。"],
        identity,
        includedInTotal: false,
        coverageReason: "AMBIGUOUS_MATCH",
      };
    }
  }

  const sourceName =
    best.item.entry.sourceName ?? `${best.item.defaults.sourceLabel}：${best.item.entry.displayName}`;
  return finalizeCatalogMatch(
    food,
    best.item,
    identity,
    best.score >= 1 ? "exact_canonical" : "strong_synonym",
    "medium",
    `已按品牌及包裝產品名對應 ${sourceName}。`,
  );
}

export function resolveFromCatalogIndex(
  food: ResolvableFood,
  index: CatalogIndex,
  localMatch: NutritionMatch | null | undefined,
  mealContext?: MealPlantMilkContext,
): NutritionMatch | null {
  if (index.entryCount === 0) return null;
  if (food.suspectedDuplicateMilk === true) return null;
  if (food.userMilkTypeChoice != null) return null;
  if (contradictoryDairyMilkLabel(food, mealContext)) return null;
  if (photoGenericMilkNeedsConfirmation(food, mealContext)) return null;

  const identity = canonicalizeFood(food);

  // Guard first: deliberately uncalculated multi-dish/dressed buckets must NEVER be bypassed
  // by branded or packaged entries.
  if (identity.dishId && DELIBERATELY_UNCALCULATED_DISH_IDS.has(identity.dishId)) {
    return null;
  }

  // Stage A1: Branded restaurant chains (e.g. HK McDonald's) override generic local matches.
  const branded = resolveBranded(food, index, identity);
  if (branded) return branded;

  // Stage A2: Packaged branded products (Open Food Facts HK/TW) match only on barcode or item-level brand + product.
  const packaged = resolvePackagedBranded(food, index, identity, localMatch);
  if (packaged) return packaged;

  // Stage B: Keep exact L1 curated local matches authoritative.
  // If L1 only matched via a broad substring fallback (e.g. "上海粗炒麵" -> generic "fried-noodles"),
  // allow an exact HK CFS FRL match to upgrade it; never let TFND/USDA override L1.
  if (localMatch?.includedInTotal) {
    if (isExactLocalMatch(food, localMatch)) return null;
    if (isUnsweetenedLemonTea(food) || chocolateMilkName(food)) return null;
    return resolveRegional(food, index, identity, new Set<CatalogSourceKind>(["regional_hk"]));
  }

  // Stage C: Respect negative rules for unsweetened lemon tea and chocolate milk.
  if (isUnsweetenedLemonTea(food) || chocolateMilkName(food)) return null;

  // Stage D: If L1 already has a curated profile under this exact name (e.g. "薯條" refused by L1's
  // composite dish gate, or a curated L1 item with an unsupported unit), respect L1's decision and
  // do not silently fall through to regional/USDA entries.
  if (isExactCuratedLocalName(food)) return null;

  const regional = resolveRegional(food, index, identity);
  if (regional) return regional;

  // Stage E: Offline USDA Foundation + SR Legacy fallback (non-composite ingredients only).
  return resolveUsdaOffline(food, index, identity, mealContext);
}
