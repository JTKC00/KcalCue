import {
  cleanName,
  fetchBuffer,
  readZipEntries,
  round1,
} from "../shared.mjs";

export const SOURCE_KEY = "usda-fdc";
const USDA_FOUNDATION_ZIP_URL =
  "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_foundation_food_json_2025-04-24.zip";
const USDA_SR_LEGACY_ZIP_URL =
  "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_sr_legacy_food_json_2018-04.zip";

const DATA_NOTICE =
  "KcalCue 參考營養資料；數值來自離線 USDA FoodData Central（Foundation / SR Legacy），並非此餐的化驗結果。";
const ATTRIBUTION =
  "U.S. Department of Agriculture, FoodData Central（Foundation Foods / SR Legacy，公有領域／CC0）。";

const EXCLUDED_CATEGORIES = new Set([
  "Fast Foods",
  "Restaurant Foods",
  "Baby Foods",
  "Meals, Entrees, and Side Dishes",
  "American Indian/Alaska Native Foods",
]);

// Exclude US commercial branded entries baked into SR Legacy (at start or after a category prefix
// such as "Snacks, KRAFT, CORNNUTS" or "Cereals ready-to-eat, KELLOGG'S, ...") so generic lookups stay clean.
const US_BRAND_RE =
  /(?:^|,\s*)(?:MCDONALD'S|BURGER KING|WENDY'S|KFC|TACO BELL|PIZZA HUT|DOMINO'S|LITTLE CAESARS|PAPA JOHN'S|SUBWAY|DENNY'S|APPLEBEE'S|OLIVE GARDEN|CRACKER BARREL|T\.G\.I\. FRIDAY'S|POPEYES|CHICK-FIL-A|ARBY'S|CARRABA'S|CARRABBA'S|STARBUCKS|KELLOGG(?:'S)?|GENERAL MILLS|POST(?=,)|QUAKER|CAMPBELL(?:'S)?|KRAFT|OSCAR MAYER|HORMEL|HEINZ|PILLSBURY|NABISCO|KEEBLER|PEPPERIDGE FARM|ARCHWAY|INTERSTATE BRANDS|GEORGE WESTON|SCHIFF|SLIMFAST|ENSURE|BOOST(?=,)|NESTLE|MARS SNACKFOOD|HERSHEY(?:'S)?|HOSTESS|MCKEE|LITTLE DEBBIE|MURRAY|WORTHINGTON|LOMA LINDA|MORNINGSTAR|BOCA|GARDENBURGER|AMY'S|STOUFFER(?:'S)?|LEAN CUISINE|HEALTHY CHOICE|MARIE CALLENDER(?:'S)?|HUNGRY-MAN|BANQUET|MICHELINA(?:'S)?|DIGIORNO|RED BARON|TOMBSTONE|TOTINO(?:'S)?|HOT POCKETS|SMART ONES|WEIGHT WATCHERS|KASHI|NATURE VALLEY|CLIF BAR|LUNA BAR|POWERBAR|GATORADE|COCA-COLA|PEPSI(?:CO)?|MOUNTAIN DEW|SPRITE|DR PEPPER|SEVEN UP|SILK(?=,)|SO DELICIOUS|BLUE DIAMOND|ALMOND BREEZE|V8(?=,)|OCEAN SPRAY|TROPICANA|MINUTE MAID|MOTT'?S|WELCH'S|CHOBANI|DANNON|YOPLAIT|FAGE|SARGENTO|LAND O LAKES|HELLMANN'S|BEST FOODS|MIRACLE WHIP|HIDDEN VALLEY|NEWMAN'S OWN|PREGO|RAGU|CLASSICO|BARILLA|UNCLE BEN'S|RICE-A-RONI|LIPTON|KNORR|SWANSON|PROGRESSO|PACE(?=,)|OLD EL PASO|ORTEGA|MISSION FOODS|TOSTITOS|DORITOS|LAY'S|RUFFLES|CHEETOS|FRITOS|PRINGLES|CHEEZ-IT|GOLDFISH|OREO|CHIPS AHOY|RITZ(?=,)|TRISCUIT|WHEAT THINS|SNICKERS|M&M|REESE'S|KIT KAT|TWIX|SKITTLES|STARBURST|HARIBO|FRITO-LAY|CORNNUTS)\b/i;

function mapUsdaCategory(categoryDesc) {
  const c = (categoryDesc ?? "").toLowerCase();
  if (c.includes("poultry")) return "poultry";
  if (c.includes("beef")) return "beef";
  if (c.includes("pork") || c.includes("lamb") || c.includes("sausage")) return "pork";
  if (c.includes("finfish") || c.includes("shellfish")) return "seafood";
  if (c.includes("dairy") || c.includes("egg")) return c.includes("egg") ? "egg" : "dairy";
  if (c.includes("vegetable")) return "vegetable";
  if (c.includes("fruit")) return "fruit";
  if (c.includes("legume")) return "tofu";
  if (c.includes("cereal") || c.includes("grain") || c.includes("pasta")) return "rice";
  if (c.includes("baked")) return "bread";
  if (c.includes("fat") || c.includes("oil") || c.includes("sauce") || c.includes("soup") || c.includes("spice")) return "sauce";
  if (c.includes("beverage")) return "mixed";
  return "unknown";
}

function inferUsdaPreparations(description) {
  const d = description.toLowerCase();
  const preps = [];
  if (/\braw\b|\buncooked\b/.test(d)) preps.push("raw");
  if (/\bsteamed\b/.test(d)) preps.push("steamed");
  if (/\bboiled\b|\bpoached\b|\bsimmered\b|\bstewed\b/.test(d)) preps.push("boiled");
  if (/\bbroiled\b|\bgrilled\b|\broasted\b|\bbaked\b/.test(d)) preps.push("grilled");
  if (/\bpan-fried\b|\bpan fried\b|\bsauteed\b/.test(d)) preps.push("pan_fried");
  if (/\bstir-fried\b|\bstir fried\b/.test(d)) preps.push("stir_fried");
  if (/\bdeep-fried\b|\bdeep fried\b|\bfried\b/.test(d)) preps.push("deep_fried");
  if (/\bcooked\b|\bprepared\b|\bcanned\b/.test(d)) preps.push("cooked");
  if (preps.length === 0) preps.push("unknown");
  return [...new Set(preps)];
}

function extractUsdaMacros(foodNutrients) {
  let kcal208 = null;
  let kcal957 = null;
  let kcal958 = null;
  let protein = null;
  let carbs = null;
  let fat = null;

  for (const item of foodNutrients ?? []) {
    const num = String(item?.nutrient?.number ?? "").trim();
    const unit = String(item?.nutrient?.unitName ?? "").trim().toLowerCase();
    const amount = item?.amount;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) continue;

    if (num === "208" && (unit === "kcal" || unit === "kilocalorie" || unit === "kilocalories")) {
      kcal208 = amount;
    } else if (num === "957" && unit === "kcal") {
      kcal957 = amount;
    } else if (num === "958" && unit === "kcal") {
      kcal958 = amount;
    } else if (num === "203" && unit === "g") {
      protein = amount;
    } else if (num === "204" && unit === "g") {
      fat = amount;
    } else if (num === "205" && unit === "g") {
      carbs = amount;
    }
  }

  const kcal = kcal208 ?? kcal957 ?? kcal958;
  if (kcal === null || protein === null || carbs === null || fat === null) return null;
  if (kcal > 950) return null;
  return { kcal, protein, carbs, fat };
}

function extractSafePortions(foodPortions, isBeverage) {
  const gramsPerUnit = isBeverage ? { g: 1, ml: 1 } : { g: 1 };
  for (const portion of foodPortions ?? []) {
    const gramWeight = portion?.gramWeight;
    const amount = typeof portion?.amount === "number" && portion.amount > 0 ? portion.amount : 1;
    if (typeof gramWeight !== "number" || !Number.isFinite(gramWeight) || gramWeight <= 0) continue;
    const perSingle = Math.round(gramWeight / amount);
    if (perSingle < 2 || perSingle > 1500) continue;

    const unitText = `${portion?.measureUnit?.name ?? ""} ${portion?.modifier ?? ""}`.toLowerCase().trim();
    if (!gramsPerUnit.cup && /\bcup\b/.test(unitText) && !/mini|quarter|half|tablespoon|teaspoon/.test(unitText)) {
      gramsPerUnit.cup = perSingle;
    } else if (
      !gramsPerUnit.piece &&
      /\b(?:medium|whole|piece|egg|fruit|slice|patty|fillet|breast|thigh|wing|drumstick|link|strip|spear|stalk)\b/.test(unitText) &&
      !/cup|tbsp|tsp|oz|lb|package|box|can|bottle|jar/.test(unitText)
    ) {
      gramsPerUnit.piece = perSingle;
    }
  }
  return gramsPerUnit;
}

async function loadUsdaDataset(url, datasetPrefix) {
  const buffer = await fetchBuffer(url, 90_000);
  const zip = readZipEntries(buffer);
  const jsonName = [...zip.keys()].find((name) => name.endsWith(".json"));
  if (!jsonName) throw new Error(`Missing JSON in ${url}`);
  const parsed = JSON.parse(zip.get(jsonName).toString("utf8"));
  const rootKey = Object.keys(parsed)[0];
  const items = Array.isArray(parsed[rootKey]) ? parsed[rootKey] : [];
  return { datasetPrefix, items };
}

export async function fetchUsdaFdcSource(retrievedAt) {
  const [foundation, srLegacy] = await Promise.all([
    loadUsdaDataset(USDA_FOUNDATION_ZIP_URL, "usda-foundation"),
    loadUsdaDataset(USDA_SR_LEGACY_ZIP_URL, "usda-sr-legacy"),
  ]);

  const entries = [];
  const seenIds = new Set();
  let skippedCategoryOrBrand = 0;
  let skippedMissingMacros = 0;

  // Load Foundation first so newer Foundation entries win on duplicate fdcId if any.
  for (const dataset of [foundation, srLegacy]) {
    for (const food of dataset.items) {
      const fdcId = food?.fdcId;
      const description = cleanName(food?.description);
      if (!fdcId || !description || description.length > 220) continue;
      if (seenIds.has(fdcId)) continue;

      const categoryDesc = cleanName(food?.foodCategory?.description);
      if (EXCLUDED_CATEGORIES.has(categoryDesc) || US_BRAND_RE.test(description)) {
        skippedCategoryOrBrand += 1;
        continue;
      }

      const macros = extractUsdaMacros(food.foodNutrients);
      if (!macros) {
        skippedMissingMacros += 1;
        continue;
      }

      seenIds.add(fdcId);
      const isBeverage = categoryDesc.toLowerCase().includes("beverage");
      const category = mapUsdaCategory(categoryDesc);
      const preparations = inferUsdaPreparations(description);
      const gramsPerUnit = extractSafePortions(food.foodPortions, isBeverage);
      const id = `${SOURCE_KEY}-${fdcId}`;

      entries.push({
        id,
        displayName: description,
        canonicalName: id,
        category,
        preparations,
        composite: false,
        searchText: description,
        kcal: round1(macros.kcal),
        protein: round1(macros.protein),
        carbs: round1(macros.carbs),
        fat: round1(macros.fat),
        gramsPerUnit,
        sourceId: `${dataset.datasetPrefix}:${fdcId}`,
        densityBasis: `離線 USDA FoodData Central（${dataset.datasetPrefix === "usda-foundation" ? "Foundation" : "SR Legacy"} FDC ${fdcId}）每 100 g 參考值。`,
      });
    }
  }

  return {
    sourceKey: SOURCE_KEY,
    defaults: {
      sourceKey: SOURCE_KEY,
      kind: "usda_offline",
      priority: 20,
      provider: "kcalcue-reference",
      sourceLabel: "USDA FoodData Central（離線）",
      attribution: ATTRIBUTION,
      dataNotice: DATA_NOTICE,
      brandAliases: [],
      retrievedAt,
    },
    entries,
    meta: {
      foundationRaw: foundation.items.length,
      srLegacyRaw: srLegacy.items.length,
      skippedCategoryOrBrand,
      skippedMissingMacros,
    },
  };
}
