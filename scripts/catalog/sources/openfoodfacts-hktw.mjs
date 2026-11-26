import {
  SYNC_USER_AGENT,
  cleanName,
  round1,
  uniqueStrings,
} from "../shared.mjs";

export const SOURCE_KEY = "openfoodfacts-hktw";
const OFF_SEARCH_BASE = "https://world.openfoodfacts.org/api/v2/search";
const PAGE_SIZE = 100;
// OFF Search API v2 hard-caps anonymous pagination at page 10 (1,000 products/query).
// Filtering by states_tags_en=nutrition-facts-completed,brands-completed ensures every
// fetched slot already has nutrition facts and brand metadata.
const OFF_MAX_ANONYMOUS_PAGES = 10;
const DEFAULT_HK_MAX_PAGES = 10; // Top 1,000 most popular HK products with complete nutrition + brand
const DEFAULT_TW_MAX_PAGES = 10; // Top 1,000 most popular TW products with complete nutrition + brand
// OFF Search API v2 documents a 10 requests/minute limit -> 6.1 s minimum spacing across all requests.
const DEFAULT_MIN_INTERVAL_MS = 6100;
const MAX_RETRIES = 5;
const RETRYABLE_HTTP_STATUSES = new Set([429, 500, 502, 503, 504]);

const DATA_NOTICE =
  "KcalCue 參考營養資料；包裝食品數值來自 Open Food Facts 香港／台灣社群資料庫，已經熱量一致性過濾，仍建議核對包裝營養標籤。";
const ATTRIBUTION =
  "Open Food Facts（香港及台灣包裝食品子集，經數值與 Atwater 公式驗算過濾）。";

const FIELDS = [
  "code",
  "product_name",
  "product_name_zh",
  "product_name_en",
  "brands",
  "quantity",
  "product_quantity",
  "product_quantity_unit",
  "nutrition_data_per",
  "categories_tags",
  "nutriments",
].join(",");

// Bilingual HK/TW brand alias pairs (proper brand names only; never generic food categories).
const BRAND_EQUIVALENTS = [
  ["vitasoy", "維他奶"],
  ["calci-plus", "鈣思寶"],
  ["vita", "維他"],
  ["meiji", "明治"],
  ["calbee", "卡樂b"],
  ["nissin", "日清"],
  ["yakult", "益力多"],
  ["pocari sweat", "寶礦力"],
  ["nestle", "雀巢"],
  ["nestlé", "雀巢"],
  ["trappist", "十字牌"],
  ["kowloon dairy", "維記"],
  ["coca-cola", "可口可樂"],
  ["pepsi", "百事"],
  ["lay's", "樂事"],
  ["tao ti", "道地"],
  ["kuang chuan", "光泉"],
  ["i-mei", "義美"],
  ["uni-president", "統一"],
  ["quaker", "桂格"],
  ["kellogg's", "家樂氏"],
  ["oatly", "oatly"],
  ["bonaqua", "飛雪"],
  ["minute maid", "美粒果"],
  ["nongfu spring", "農夫山泉"],
  ["tsingtao", "青島"],
  ["asahi", "朝日"],
  ["kirin", "麒麟"],
  ["suntory", "三得利"],
  ["ito en", "伊藤園"],
  ["lotte", "樂天"],
  ["glico", "固力果"],
  ["morinaga", "森永"],
  ["oishi", "上好佳"],
  ["want want", "旺旺"],
  ["master kong", "康師傅"],
];

const BARCODE_RE = /^\d{8,14}$/;
const CJK_RE = /[\u3400-\u9fff]/;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfterMs(headerValue) {
  if (!headerValue) return null;
  const seconds = Number(headerValue.trim());
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1000, 60_000);
  }
  const dateMs = Date.parse(headerValue);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? Math.min(delta, 60_000) : null;
  }
  return null;
}

class NonRetryableHttpError extends Error {
  constructor(message) {
    super(message);
    this.name = "NonRetryableHttpError";
  }
}

async function fetchOffPage(country, page, paceState) {
  const url =
    `${OFF_SEARCH_BASE}?countries_tags_en=${encodeURIComponent(country)}` +
    `&states_tags_en=nutrition-facts-completed,brands-completed` +
    `&sort_by=popularity_key&page_size=${PAGE_SIZE}&page=${page}&fields=${FIELDS}`;

  let lastError = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const waitMs = paceState.nextAllowedAt - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    paceState.nextAllowedAt = Date.now() + paceState.minIntervalMs;

    try {
      const response = await fetch(url, {
        headers: { "User-Agent": SYNC_USER_AGENT },
        signal: AbortSignal.timeout(25_000),
      });
      if (response.ok) {
        const payload = await response.json();
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.products)) {
          throw new Error(`Malformed OFF response for ${country} page ${page}: missing products array`);
        }
        return payload;
      }
      if (RETRYABLE_HTTP_STATUSES.has(response.status) && attempt < MAX_RETRIES) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        const backoffMs = retryAfterMs ?? Math.min(30_000, 2000 * 2 ** attempt);
        paceState.nextAllowedAt = Math.max(paceState.nextAllowedAt, Date.now() + backoffMs);
        continue;
      }
      throw new NonRetryableHttpError(`HTTP ${response.status} for OFF ${country} page ${page}`);
    } catch (error) {
      if (error instanceof NonRetryableHttpError) throw error;
      lastError = error;
      if (attempt < MAX_RETRIES) {
        const backoffMs = Math.min(30_000, 2000 * 2 ** attempt);
        paceState.nextAllowedAt = Math.max(paceState.nextAllowedAt, Date.now() + backoffMs);
        continue;
      }
    }
  }
  throw lastError ?? new Error(`Failed OFF ${country} page ${page}`);
}

function finiteNonNeg(value) {
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }
  return null;
}

export function passesAtwaterSanity(kcal, protein, carbs, fat, fiber, alcohol) {
  if (kcal > 950 || protein > 100 || carbs > 100 || fat > 100) return false;
  if (protein + carbs + fat > 105) return false;
  const f = fiber ?? 0;
  const alc = alcohol ?? 0;
  const low = 4 * protein + 4 * Math.max(0, carbs - f) + 2 * Math.min(carbs, f) + 9 * fat + 7 * alc;
  const high = 4 * protein + 4 * carbs + 9 * fat + 7 * alc;
  // Reject 0–5 kcal claims when reported macros imply > 12 kcal (e.g., 0 kcal + 7 g carbs = 28 kcal).
  if (kcal <= 5 && low > 12) return false;
  const ref = Math.max(kcal, high);
  const absBuffer = Math.min(25, Math.max(8, 0.25 * ref));
  if (kcal >= low - absBuffer && kcal <= high + absBuffer) return true;
  const tolerance = Math.max(8, 0.3 * ref);
  const dist = kcal < low ? low - kcal : kcal - high;
  return dist <= tolerance;
}

const MULTIPACK_RE =
  /(?:\b\d+\s*[x×*]\s*\d+|\b\d+(?:\.\d+)?\s*(?:ml|mL|l|L|g|kg)\s*[x×*]\s*\d+|\b(?:pack|box|case)\s+of\s+[2-9]\d*\b|\b[2-9]\d*\s*(?:packs?|cans?|bottles?|cartons?|bars?|pouches|pcs)\b|[2-9]\d*\s*(?:包裝|盒裝|罐裝|支裝|樽裝|入裝|包|盒|罐|支|樽|入))/i;

const SOLID_OR_POWDER_CATEGORY_RE =
  /chips|crisps|potato-chips|snacks|biscuits|cookies|crackers|candies|confectioneries|chocolates|cakes|breads|noodles|pastas|rices|meats|seafood|fishes|cheeses|nuts|cereals|oatmeals|powders|tea-bags|instant-beverages|drink-mixes|dry-mixes|jams|spreads|sauces|oils|butters/;

const SOLID_OR_POWDER_NAME_RE =
  /薯片|洋芋片|餅乾|饼干|脆片|麵|面|飯|饭|粉|沖劑|冲剂|沖泡|茶包|茶葉|朱古力條|巧克力棒|堅果|果仁|芝士|乳酪塊|\b(?:chips|crisps|biscuits?|cookies?|crackers?|noodles?|pasta|rice|powder|mix|tea\s*bags?|bars?|nuts?|candy|candies)\b/i;

const BEVERAGE_CATEGORY_RE =
  /beverages|milks|plant-based-beverages|teas|juices|waters|sodas|coffee-drinks|soft-drinks|dairy-drinks|soy-milks|oat-milks/;

const EXPLICIT_LIQUID_NAME_RE =
  /飲品|飲料|饮料|豆奶|豆漿|鮮奶|鮮乳|牛奶|燕麥奶|茶飲|檸檬茶|奶茶|果汁|汽水|可樂|礦泉水|礦物質水|咖啡飲|\b(?:milk|soy\s*milk|soya|oat\s*milk|tea|juice|water|soda|cola|drink|beverage|coffee|latte)\b/i;

export function parsePackSize(product) {
  const text = String(product.quantity ?? "").trim();
  // Never invent a single-piece weight for multi-packs (e.g. "6 x 250 ml"): "piece" is ambiguous
  // between one pack and the full carton.
  if (MULTIPACK_RE.test(text)) return null;

  const numQty = finiteNonNeg(product.product_quantity);
  const unitRaw = String(product.product_quantity_unit ?? "").trim().toLowerCase();
  if (numQty !== null && numQty > 0) {
    if (unitRaw === "l" || unitRaw === "kg") {
      const scaled = Math.round(numQty * 1000);
      return scaled >= 5 && scaled <= 1500 ? { amount: scaled, isLiquid: unitRaw === "l" } : null;
    }
    if (unitRaw === "ml" || unitRaw === "g") {
      const rounded = Math.round(numQty);
      return rounded >= 5 && rounded <= 1500 ? { amount: rounded, isLiquid: unitRaw === "ml" } : null;
    }
  }

  const match = text.match(/(\d+(?:\.\d+)?)\s*(ml|mL|l|L|g|kg)\b/);
  if (!match) return null;
  const rawNum = Number(match[1]);
  const u = match[2].toLowerCase();
  if (!Number.isFinite(rawNum) || rawNum <= 0) return null;
  const amount = Math.round(u === "l" || u === "kg" ? rawNum * 1000 : rawNum);
  if (amount < 5 || amount > 1500) return null;
  return { amount, isLiquid: u === "ml" || u === "l" };
}

export function isLiquidProduct(product, pack, kcal) {
  const cats = Array.isArray(product.categories_tags) ? product.categories_tags.join(" ").toLowerCase() : "";
  const names = `${product.product_name ?? ""} ${product.product_name_zh ?? ""} ${product.product_name_en ?? ""}`;
  // Solid snacks, chips, powders, oils, and high-calorie dry mixes (> 160 kcal/100g) must never get ml=1.
  if (typeof kcal === "number" && kcal > 160) return false;
  if (SOLID_OR_POWDER_NAME_RE.test(names)) return false;
  if (SOLID_OR_POWDER_CATEGORY_RE.test(cats) && !EXPLICIT_LIQUID_NAME_RE.test(names)) {
    return false;
  }

  const hasBeverageCat = BEVERAGE_CATEGORY_RE.test(cats);
  const hasLiquidName = EXPLICIT_LIQUID_NAME_RE.test(names);
  if (!hasBeverageCat && !hasLiquidName) return false;

  if (pack?.isLiquid) return true;
  if (String(product.nutrition_data_per ?? "").toLowerCase().includes("ml")) return true;
  const qty = String(product.quantity ?? "").toLowerCase();
  if (/\b\d+(?:\.\d+)?\s*(?:ml|l)\b/.test(qty)) return true;
  return hasBeverageCat;
}

function inferOffCategory(product) {
  const cats = Array.isArray(product.categories_tags) ? product.categories_tags.join(" ").toLowerCase() : "";
  if (cats.includes("dairies") || cats.includes("milks") || cats.includes("yogurt") || cats.includes("cheese")) {
    return "dairy";
  }
  if (cats.includes("plant-based-beverages") || cats.includes("soy")) return "dairy";
  if (cats.includes("noodles") || cats.includes("pasta")) return "noodles";
  if (cats.includes("bread") || cats.includes("biscuit") || cats.includes("cereal")) return "bread";
  if (cats.includes("sauce") || cats.includes("condiment") || cats.includes("oil")) return "sauce";
  if (cats.includes("chips") || cats.includes("crisps")) return "fried";
  if (cats.includes("seafood") || cats.includes("fish")) return "seafood";
  if (cats.includes("fruit")) return "fruit";
  if (cats.includes("vegetable")) return "vegetable";
  return "mixed";
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasLatinBrandToken(text, brandEn) {
  return new RegExp(`(?:^|[^a-z0-9])${escapeRegExp(brandEn)}(?:[^a-z0-9]|$)`, "i").test(text);
}

function buildBrandAliases(rawBrands) {
  const parts = String(rawBrands ?? "")
    .split(/[,，/／|]+/)
    .map((s) => cleanName(s))
    .filter((s) => s.length >= 2 && s.length <= 60);

  const expanded = [...parts];
  const lowerJoined = parts.join(" ").toLowerCase();
  for (const [en, zh] of BRAND_EQUIVALENTS) {
    if (hasLatinBrandToken(lowerJoined, en) || parts.some((p) => p.includes(zh))) {
      expanded.push(en, zh);
    }
  }
  return uniqueStrings(expanded, 10);
}

function chooseNames(product) {
  const zh = cleanName(product.product_name_zh);
  const generic = cleanName(product.product_name);
  const en = cleanName(product.product_name_en);

  const primary = zh || (CJK_RE.test(generic) ? generic : "") || generic || en;
  const aliases = uniqueStrings([zh, generic, en], 6);
  const searchText = aliases.join(" ").slice(0, 230).trim();
  return { primary: primary.slice(0, 180), aliases, searchText };
}

function envPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export async function fetchOpenFoodFactsHkTwSource(retrievedAt) {
  const hkMaxPages = Math.min(
    envPositiveInt("OFF_HK_MAX_PAGES", DEFAULT_HK_MAX_PAGES),
    OFF_MAX_ANONYMOUS_PAGES,
  );
  const twMaxPages = Math.min(
    envPositiveInt("OFF_TW_MAX_PAGES", DEFAULT_TW_MAX_PAGES),
    OFF_MAX_ANONYMOUS_PAGES,
  );

  const seenBarcodes = new Set();
  const entries = [];
  const stats = {
    hkPagesFetched: 0,
    twPagesFetched: 0,
    hkRawProducts: 0,
    twRawProducts: 0,
    skippedInvalidBarcode: 0,
    skippedDuplicate: 0,
    skippedMissingNameOrBrand: 0,
    skippedMissingMacros: 0,
    skippedFailedAtwater: 0,
  };

  const minIntervalMs = Math.max(250, envPositiveInt("OFF_MIN_INTERVAL_MS", DEFAULT_MIN_INTERVAL_MS));
  const paceState = { nextAllowedAt: 0, minIntervalMs };

  const countryPlan = [
    { country: "hong-kong", regionLabel: "香港", maxPages: hkMaxPages },
    { country: "taiwan", regionLabel: "台灣", maxPages: twMaxPages },
  ];

  for (const { country, regionLabel, maxPages } of countryPlan) {
    for (let page = 1; page <= maxPages; page++) {
      const payload = await fetchOffPage(country, page, paceState);
      const products = payload.products;
      if (country === "hong-kong") {
        stats.hkPagesFetched += 1;
        stats.hkRawProducts += products.length;
      } else {
        stats.twPagesFetched += 1;
        stats.twRawProducts += products.length;
      }

      for (const product of products) {
        const code = String(product.code ?? "").trim();
        if (!BARCODE_RE.test(code)) { stats.skippedInvalidBarcode += 1; continue; }
        if (seenBarcodes.has(code)) { stats.skippedDuplicate += 1; continue; }

        const { primary, aliases, searchText } = chooseNames(product);
        const itemBrandAliases = buildBrandAliases(product.brands);
        if (!primary || !searchText || itemBrandAliases.length === 0) {
          stats.skippedMissingNameOrBrand += 1;
          continue;
        }

        const nutriments = product.nutriments ?? {};
        const kcal = finiteNonNeg(nutriments["energy-kcal_100g"]);
        const protein = finiteNonNeg(nutriments.proteins_100g);
        const carbs = finiteNonNeg(nutriments.carbohydrates_100g);
        const fat = finiteNonNeg(nutriments.fat_100g);
        if (kcal === null || protein === null || carbs === null || fat === null) {
          stats.skippedMissingMacros += 1;
          continue;
        }

        const fiber = finiteNonNeg(nutriments.fiber_100g);
        const alcohol = finiteNonNeg(nutriments.alcohol_100g);
        if (!passesAtwaterSanity(kcal, protein, carbs, fat, fiber, alcohol)) {
          stats.skippedFailedAtwater += 1;
          continue;
        }

        seenBarcodes.add(code);
        const pack = parsePackSize(product);
        const liquid = isLiquidProduct(product, pack, kcal);
        const gramsPerUnit = liquid ? { g: 1, ml: 1 } : { g: 1 };
        if (pack) gramsPerUnit.piece = pack.amount;

        const id = `${SOURCE_KEY}-${code}`;
        const brandDisplay = itemBrandAliases[0];
        const displayName = primary.toLowerCase().includes(brandDisplay.toLowerCase())
          ? primary
          : `${brandDisplay} ${primary}`.slice(0, 180);
        const unitLabel = liquid ? "100 ml" : "100 g";
        const packNote = pack ? `；單件包裝約 ${pack.amount} ${liquid ? "ml" : "g"}` : "";

        entries.push({
          id,
          displayName,
          canonicalName: id,
          category: inferOffCategory(product),
          preparations: ["raw", "cooked", "unknown"],
          composite: true,
          brandedAliases: aliases,
          itemBrandAliases,
          barcode: code,
          searchText,
          kcal: round1(kcal),
          protein: round1(protein),
          carbs: round1(carbs),
          fat: round1(fat),
          gramsPerUnit,
          sourceId: `off:${code}`,
          densityBasis: `Open Food Facts（${regionLabel}包裝食品，條碼 ${code}）每 ${unitLabel} 標籤參考值${packNote}。`,
        });
      }

      const totalPages = typeof payload.count === "number"
        ? Math.ceil(payload.count / PAGE_SIZE)
        : maxPages;
      if (products.length === 0 || page >= totalPages) break;
    }
  }

  return {
    sourceKey: SOURCE_KEY,
    defaults: {
      sourceKey: SOURCE_KEY,
      kind: "packaged_branded",
      priority: 90,
      provider: "kcalcue-reference",
      sourceLabel: "Open Food Facts 包裝食品",
      attribution: ATTRIBUTION,
      dataNotice: DATA_NOTICE,
      brandAliases: [],
      retrievedAt,
    },
    entries,
    meta: stats,
  };
}
