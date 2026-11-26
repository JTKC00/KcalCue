import {
  cleanName,
  fetchBuffer,
  readZipEntries,
  round1,
  uniqueStrings,
} from "../shared.mjs";

export const SOURCE_KEY = "tfnd-tw";
const TFND_JSON_ZIP_URL =
  "https://data.fda.gov.tw/opendata/exportDataList.do?method=ExportData&InfoId=20&logType=3";

const DATA_NOTICE =
  "KcalCue 參考營養資料；數值來自台灣衛福部食藥署「食品營養成分資料庫（TFND）」公開參考值，並非此餐的化驗結果。";
const ATTRIBUTION =
  "台灣衛生福利部食品藥物管理署（TFDA）食品營養成分資料庫（data.gov.tw 資料集 8543）。";

// Common Taiwan -> Hong Kong vocabulary equivalents scoped by category so cross-food
// regional nicknames (e.g. 小黃魚's nickname "小黃瓜") never pollute unrelated food categories.
const TW_TO_HK_TERMS = [
  { tw: "馬鈴薯", hk: "薯仔", categories: ["澱粉類", "蔬菜類", "加工調理食品及其他類", "糕餅點心類"] },
  { tw: "高麗菜", hk: "椰菜", categories: ["蔬菜類", "加工調理食品及其他類"] },
  { tw: "甘藍", hk: "椰菜", categories: ["蔬菜類"] },
  { tw: "地瓜", hk: "蕃薯", categories: ["澱粉類", "蔬菜類", "糕餅點心類", "加工調理食品及其他類"] },
  { tw: "番薯", hk: "蕃薯", categories: ["澱粉類", "蔬菜類", "糕餅點心類", "加工調理食品及其他類"] },
  { tw: "起司", hk: "芝士" },
  { tw: "乳酪絲", hk: "芝士絲", categories: ["乳品類"] },
  { tw: "綠花椰菜", hk: "西蘭花", categories: ["蔬菜類"] },
  { tw: "青花菜", hk: "西蘭花", categories: ["蔬菜類"] },
  { tw: "白花椰菜", hk: "椰菜花", categories: ["蔬菜類"] },
  { tw: "花椰菜", hk: "椰菜花", categories: ["蔬菜類"] },
  { tw: "鳳梨", hk: "菠蘿", categories: ["水果類", "飲料類", "糕餅點心類", "加工調理食品及其他類"] },
  { tw: "酪梨", hk: "牛油果", categories: ["水果類", "油脂類", "飲料類"] },
  { tw: "小黃瓜", hk: "青瓜", categories: ["蔬菜類"] },
  { tw: "花胡瓜", hk: "青瓜", categories: ["蔬菜類"] },
  { tw: "優格", hk: "乳酪", categories: ["乳品類", "飲料類", "糕餅點心類"] },
  { tw: "毛豆仁", hk: "枝豆", categories: ["豆類", "蔬菜類"] },
  { tw: "毛豆", hk: "枝豆", categories: ["豆類", "蔬菜類"] },
  { tw: "蛤蜊", hk: "蜆", categories: ["魚貝類"] },
  { tw: "芭樂", hk: "番石榴", categories: ["水果類", "飲料類"] },
  { tw: "杏鮑菇", hk: "雞脾菇", categories: ["菇類", "蔬菜類"] },
  { tw: "鮪魚", hk: "吞拿魚", categories: ["魚貝類", "加工調理食品及其他類"] },
  { tw: "鮭魚", hk: "三文魚", categories: ["魚貝類", "加工調理食品及其他類"] },
  { tw: "柳丁", hk: "甜橙", categories: ["水果類", "飲料類"] },
  { tw: "番茄", hk: "蕃茄" },
  { tw: "泡麵", hk: "即食麵", categories: ["穀物類", "加工調理食品及其他類"] },
  { tw: "吐司", hk: "方包", categories: ["穀物類", "糕餅點心類"] },
  { tw: "芭蕉", hk: "大蕉", categories: ["水果類"] },
  { tw: "洋蔥", hk: "洋葱" },
  { tw: "雞腿", hk: "雞脾", categories: ["肉類", "加工調理食品及其他類"] },
];

// Overly broad TFND common names that often appear on flavored or specific samples (e.g. 低脂調味乳(木瓜) -> 牛奶).
const OVERBROAD_COMMON_NAMES = new Set([
  "牛乳", "牛奶", "鮮奶", "鮮乳", "奶", "大豆", "黃豆",
  "雞蛋", "蛋", "豬肉", "牛肉", "雞肉", "魚", "米", "麵", "麵包", "茶", "果汁",
]);

// Cross-category homonym common names (e.g. 小黃魚 has regional nickname 小黃瓜 in TFND).
const CATEGORY_RESTRICTED_COMMON_NAMES = new Map([
  ["小黃瓜", new Set(["蔬菜類"])],
  ["黃瓜", new Set(["蔬菜類"])],
  ["青瓜", new Set(["蔬菜類"])],
]);

function stripSamplingTag(name) {
  return name.replace(/\s*[（(][^()（）]*取樣[^()（）]*[)）]\s*$/u, "").trim();
}

function expandHkTerms(name, categoryName) {
  const variants = [];
  for (const { tw, hk, categories } of TW_TO_HK_TERMS) {
    if (categories && !categories.includes(categoryName)) continue;
    // Do not rewrite 綠花椰菜 with the generic 花椰菜 -> 椰菜花 rule.
    if (tw === "花椰菜" && name.includes("綠花椰菜")) continue;
    if (name.includes(tw)) {
      variants.push(name.replaceAll(tw, hk));
    }
  }
  return variants;
}

function parseTfndNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  if (!text) return null;
  const num = Number(text);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function parseUnitWeight(raw) {
  const match = String(raw ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*(?:克|g)?$/i);
  if (!match) return null;
  const weight = Number(match[1]);
  return Number.isFinite(weight) && weight >= 5 && weight <= 600 ? Math.round(weight) : null;
}

const DRY_OR_CONCENTRATE_RE =
  /粉|沖泡|冲泡|沖調|冲调|即溶|茶包|茶葉|茶叶|乾|干|粒|塊|块|濃縮|浓缩|膏|醬|酱|精|煉乳|煉奶|奶油|鮮奶油|起司|芝士|咖啡豆/;

function inferTfndMeta(categoryName, sampleName, desc, kcal) {
  const combined = `${sampleName} ${desc}`;
  const preparations = [];
  if (/生|鮮|未煮/.test(combined)) preparations.push("raw");
  if (/炸|油炸|酥炸/.test(combined)) preparations.push("deep_fried");
  if (/烤|烘|焗/.test(combined)) preparations.push("grilled");
  if (/炒/.test(combined)) preparations.push("stir_fried");
  if (/煎/.test(combined)) preparations.push("pan_fried");
  if (/蒸/.test(combined)) preparations.push("steamed");
  if (/煮|川燙|水煮|滷|燉/.test(combined)) preparations.push("boiled");
  if (/熟|調理|即食|罐頭/.test(combined)) preparations.push("cooked");
  if (preparations.length === 0) {
    if (categoryName === "水果類" || categoryName === "乳品類" || categoryName === "飲料類") {
      preparations.push("raw", "unknown");
    } else if (categoryName === "糕餅點心類" || categoryName === "加工調理食品及其他類") {
      preparations.push("cooked", "unknown");
    } else {
      preparations.push("raw", "cooked", "unknown");
    }
  }

  const countable = categoryName === "水果類" || categoryName === "蛋類" || categoryName === "糕餅點心類";
  const isDryOrConcentrate = DRY_OR_CONCENTRATE_RE.test(sampleName) || kcal > 150;
  const liquid =
    !isDryOrConcentrate &&
    (categoryName === "飲料類" || (categoryName === "乳品類" && /奶|乳|飲|優酪乳/.test(sampleName)));

  switch (categoryName) {
    case "穀物類":
    case "澱粉類":
      return { category: /麵|粉/.test(sampleName) ? "noodles" : /飯|米/.test(sampleName) ? "rice" : "bread", preparations, composite: false, countable, liquid };
    case "蔬菜類":
    case "菇類":
    case "藻類":
      return { category: "vegetable", preparations, composite: false, countable, liquid };
    case "水果類":
      return { category: "fruit", preparations, composite: false, countable, liquid };
    case "魚貝類":
      return { category: "seafood", preparations, composite: false, countable, liquid };
    case "肉類":
      return {
        category: /牛/.test(sampleName) ? "beef" : /雞|鴨|鵝|火雞/.test(sampleName) ? "poultry" : "pork",
        preparations,
        composite: false,
        countable,
        liquid,
      };
    case "蛋類":
      return { category: "egg", preparations, composite: false, countable, liquid };
    case "豆類":
      return { category: "tofu", preparations, composite: false, countable, liquid };
    case "乳品類":
      return { category: "dairy", preparations, composite: false, countable, liquid };
    case "油脂類":
    case "調味料及香辛料類":
      return { category: "sauce", preparations: ["sauced", "raw", "unknown"], composite: false, countable: false, liquid: false };
    case "糕餅點心類":
    case "加工調理食品及其他類":
      return { category: "mixed", preparations, composite: true, countable, liquid };
    case "飲料類":
      return { category: "mixed", preparations, composite: true, countable: false, liquid };
    default:
      return { category: "unknown", preparations, composite: false, countable, liquid };
  }
}

function flattenRow(row) {
  if (!Array.isArray(row)) return row;
  const out = {};
  for (const part of row) {
    if (part && typeof part === "object") Object.assign(out, part);
  }
  return out;
}

export async function fetchTfndTwSource(retrievedAt) {
  const buffer = await fetchBuffer(TFND_JSON_ZIP_URL, 60_000);
  const zip = readZipEntries(buffer);
  const jsonFile = [...zip.keys()].find((name) => name.endsWith(".json"));
  if (!jsonFile) throw new Error("TFND ZIP missing JSON file");

  const rawRows = JSON.parse(zip.get(jsonFile).toString("utf8").replace(/^\uFEFF/, ""));
  const grouped = new Map();

  for (const raw of rawRows) {
    const row = flattenRow(raw);
    const id = cleanName(row["整合編號"]);
    if (!id) continue;

    let item = grouped.get(id);
    if (!item) {
      item = {
        id,
        categoryName: cleanName(row["食品分類"]),
        sampleName: cleanName(row["樣品名稱"]),
        commonNames: cleanName(row["俗名"]),
        englishNames: cleanName(row["樣品英文名稱"]),
        description: cleanName(row["內容物描述"]),
        unitWeight: parseUnitWeight(row["每單位重"]),
        kcalAdjusted: null,
        kcalRaw: null,
        protein: null,
        carbs: null,
        fat: null,
      };
      grouped.set(id, item);
    }

    const analyte = cleanName(row["分析項"]);
    const val = parseTfndNumber(row["每100克含量"]);
    if (val === null) continue;
    if (analyte === "修正熱量") item.kcalAdjusted = val;
    else if (analyte === "熱量") item.kcalRaw = val;
    else if (analyte === "粗蛋白") item.protein = val;
    else if (analyte === "總碳水化合物") item.carbs = val;
    else if (analyte === "粗脂肪") item.fat = val;
  }

  const entries = [];
  let skipped = 0;

  for (const item of grouped.values()) {
    const kcal = item.kcalAdjusted ?? item.kcalRaw;
    if (
      !item.sampleName ||
      kcal === null ||
      kcal > 950 ||
      item.protein === null ||
      item.carbs === null ||
      item.fat === null
    ) {
      skipped += 1;
      continue;
    }

    const { category, preparations, composite, countable, liquid } = inferTfndMeta(
      item.categoryName,
      item.sampleName,
      item.description,
      kcal,
    );

    const cleanedSampleName = stripSamplingTag(item.sampleName) || item.sampleName;
    const commonParts = item.commonNames
      ? item.commonNames
        .split(/[,，、;；]/)
        .map((s) => s.trim())
        .filter((s) => {
          if (s.length < 2 || s.length > 40 || OVERBROAD_COMMON_NAMES.has(s)) return false;
          const allowedCats = CATEGORY_RESTRICTED_COMMON_NAMES.get(s);
          if (allowedCats && !allowedCats.has(item.categoryName)) return false;
          return true;
        })
      : [];
    const englishParts = item.englishNames
      ? item.englishNames.split(/[;；]/).map((s) => s.trim()).filter((s) => s.length >= 3 && s.length <= 60).slice(0, 3)
      : [];

    const hkExpanded = [
      ...expandHkTerms(item.sampleName, item.categoryName),
      ...expandHkTerms(cleanedSampleName, item.categoryName),
      ...commonParts.flatMap((part) => expandHkTerms(part, item.categoryName)),
    ];

    const aliases = uniqueStrings([
      item.sampleName,
      cleanedSampleName,
      ...hkExpanded,
      ...commonParts.slice(0, 6),
      ...englishParts,
    ], 14);

    const id = `${SOURCE_KEY}-${item.id}`;
    const gramsPerUnit = liquid ? { g: 1, ml: 1 } : { g: 1 };
    if (countable && item.unitWeight) {
      gramsPerUnit.piece = item.unitWeight;
    }

    entries.push({
      id,
      displayName: item.sampleName,
      canonicalName: id,
      category,
      preparations,
      composite,
      exclusiveAliases: aliases,
      kcal: round1(kcal),
      protein: round1(item.protein),
      carbs: round1(item.carbs),
      fat: round1(item.fat),
      gramsPerUnit,
      sourceId: `${SOURCE_KEY}:${item.id}`,
      densityBasis: `台灣食藥署 TFND 每 100 g 可食部分參考值（${round1(kcal)} kcal；編號 ${item.id}）。`,
    });
  }

  return {
    sourceKey: SOURCE_KEY,
    defaults: {
      sourceKey: SOURCE_KEY,
      kind: "regional_tw",
      priority: 40,
      provider: "kcalcue-reference",
      sourceLabel: "台灣食藥署 TFND",
      attribution: ATTRIBUTION,
      dataNotice: DATA_NOTICE,
      brandAliases: [],
      retrievedAt,
    },
    entries,
    meta: { totalGrouped: grouped.size, skipped },
  };
}
