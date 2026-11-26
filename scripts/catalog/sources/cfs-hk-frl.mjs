import {
  bandAround,
  cleanName,
  fetchBuffer,
  parseXlsxSheet,
  readZipEntries,
  round1,
  uniqueStrings,
} from "../shared.mjs";

export const SOURCE_KEY = "cfs-hk-frl";
const CFS_FRL_XLSX_URL = "https://www.cfs.gov.hk/resources/Nutrient%20profiles_FRL.xlsx";

const DATA_NOTICE =
  "KcalCue 參考營養資料；數值來自香港食物安全中心食物研究化驗所（CFS FRL）公開化驗參考，並非此餐的化驗結果。";
const ATTRIBUTION =
  "香港食物環境衞生署食物安全中心（CFS）食物研究化驗所營養成分資料（cfs.gov.hk）。複合菜式保留 ±15% 餐廳配方變異範圍。";

function parseCfsNumber(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;
  const upper = text.toUpperCase();
  if (upper === "TRACE" || upper === "ND" || upper === "微量") return 0;
  if (upper === "NA" || upper === "N/A") return null;
  const num = Number(text);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

function classifyCfsGroup(zhGroup, zhName) {
  switch (zhGroup) {
    case "即食食物":
      return { category: "mixed", preparations: ["cooked", "steamed", "stir_fried", "deep_fried", "boiled", "unknown"], composite: true, liquid: false };
    case "湯類":
      return { category: "mixed", preparations: ["boiled", "cooked", "unknown"], composite: true, liquid: !/粉|沖劑|濃湯寶|湯塊/.test(zhName) };
    case "不含酒精飲料":
      return { category: "mixed", preparations: ["raw", "unknown"], composite: true, liquid: !/粉|沖劑|茶包|茶葉|乾/.test(zhName) };
    case "酒精飲料":
      return { category: "mixed", preparations: ["raw", "unknown"], composite: false, liquid: true };
    case "穀類及其製品": {
      const isBakedOrDish = /包|多士|三文治|批|餅|蛋糕|酥|撻|腸粉|麵|粉|飯/.test(zhName);
      return { category: isBakedOrDish ? "mixed" : "bread", preparations: ["cooked", "unknown"], composite: isBakedOrDish, liquid: false };
    }
    case "小食":
    case "冰凍甜點":
      return { category: "mixed", preparations: ["cooked", "deep_fried", "raw", "unknown"], composite: true, liquid: false };
    case "水果類及其製品":
      return { category: "fruit", preparations: ["raw", "unknown"], composite: false, liquid: false };
    case "蔬菜類及其製品": {
      const cooked = /蒸|炒|煎|烚|煮|焗|炸|灼/.test(zhName);
      return { category: "vegetable", preparations: cooked ? ["cooked", "stir_fried", "steamed", "boiled"] : ["raw", "cooked", "unknown"], composite: false, liquid: false };
    }
    case "禽肉類及其製品": {
      const dish = /炸|豉油|鹽酥|韓式|咖喱|燒/.test(zhName);
      return { category: "poultry", preparations: ["cooked", "deep_fried", "grilled", "unknown"], composite: dish, liquid: false };
    }
    case "畜肉類及其製品": {
      const dish = /牛雜|咖喱|滷|燒|煎|炸/.test(zhName);
      return { category: /牛/.test(zhName) ? "beef" : "pork", preparations: ["cooked", "pan_fried", "boiled", "unknown"], composite: dish, liquid: false };
    }
    case "奶類及其製品": {
      const isLiquidDairy = /奶|奶昔/.test(zhName) && !/粉|煉奶|練奶|淡奶|忌廉|奶油|芝士|乳酪|布甸|雪糕/.test(zhName);
      return { category: "dairy", preparations: ["raw", "unknown"], composite: /奶昔/.test(zhName), liquid: isLiquidDairy };
    }
    case "蛋類及其製品":
      return { category: "egg", preparations: ["pan_fried", "boiled", "cooked", "unknown"], composite: false, liquid: false };
    case "豆類及其製品":
      return { category: "tofu", preparations: ["cooked", "raw", "unknown"], composite: false, liquid: false };
    case "佐料及醬料":
      return { category: "sauce", preparations: ["sauced", "unknown"], composite: false, liquid: false };
    case "油脂類":
      return { category: "sauce", preparations: ["raw", "unknown"], composite: false, liquid: false };
    case "糖及糖類製品":
      return { category: "mixed", preparations: ["cooked", "raw", "unknown"], composite: true, liquid: false };
    default:
      return { category: "unknown", preparations: ["cooked", "unknown"], composite: false, liquid: false };
  }
}

function stripTrailingYear(name) {
  return name.replace(/\s*[（(](?:19|20)\d{2}[)）]\s*$/u, "").trim();
}

export async function fetchCfsHkFrlSource(retrievedAt) {
  const buffer = await fetchBuffer(CFS_FRL_XLSX_URL, 30_000);
  const zip = readZipEntries(buffer);
  const enRows = parseXlsxSheet(zip, "xl/worksheets/sheet1.xml");
  const zhRows = parseXlsxSheet(zip, "xl/worksheets/sheet2.xml");
  const scRows = parseXlsxSheet(zip, "xl/worksheets/sheet3.xml");

  if (enRows.length !== zhRows.length || scRows.length !== zhRows.length) {
    throw new Error(
      `CFS FRL workbook sheet row mismatch (Eng=${enRows.length}, 繁=${zhRows.length}, 简=${scRows.length})`,
    );
  }
  const rowLimit = zhRows.length;
  const entries = [];
  let skipped = 0;

  for (let i = 2; i < rowLimit; i++) {
    const en = enRows[i];
    const zh = zhRows[i];
    const sc = scRows[i];
    const zhName = cleanName(zh.C);
    if (!zhName) continue;

    const kcalVal = parseCfsNumber(zh.E);
    const proteinVal = parseCfsNumber(zh.F);
    const carbsVal = parseCfsNumber(zh.G);
    const fatVal = parseCfsNumber(zh.H);
    if (kcalVal === null || proteinVal === null || carbsVal === null || fatVal === null) {
      skipped += 1;
      continue;
    }

    const enKcal = parseCfsNumber(en.E);
    const scKcal = parseCfsNumber(sc.E);
    if (enKcal !== kcalVal || scKcal !== kcalVal) {
      throw new Error(
        `CFS FRL sheet misalignment at row ${i + 1}: zh="${zhName}" (${kcalVal}), en="${cleanName(en.C)}" (${enKcal}), sc="${cleanName(sc.C)}" (${scKcal})`,
      );
    }

    const zhGroup = cleanName(zh.A);
    const enName = cleanName(en.C);
    const scName = cleanName(sc.C);
    const { category, preparations, composite, liquid } = classifyCfsGroup(zhGroup, zhName);
    const safeLiquid = liquid && kcalVal <= 150;

    const displayName = stripTrailingYear(zhName) || zhName;
    const aliases = uniqueStrings([
      zhName,
      displayName,
      scName,
      stripTrailingYear(scName),
      enName,
      stripTrailingYear(enName),
    ], 12);

    const id = `${SOURCE_KEY}-${i + 1}`;
    const gramsPerUnit = safeLiquid ? { g: 1, ml: 1 } : { g: 1 };

    entries.push({
      id,
      displayName,
      canonicalName: id,
      category,
      preparations,
      composite,
      exclusiveAliases: aliases,
      kcal: composite ? bandAround(kcalVal, 0.15) : round1(kcalVal),
      protein: composite ? bandAround(proteinVal, 0.15) : round1(proteinVal),
      carbs: composite ? bandAround(carbsVal, 0.15) : round1(carbsVal),
      fat: composite ? bandAround(fatVal, 0.15) : round1(fatVal),
      gramsPerUnit,
      sourceId: `${SOURCE_KEY}:row-${i + 1}`,
      densityBasis: composite
        ? `香港食安中心食物研究化驗所（CFS FRL）實測中位 ${round1(kcalVal)} kcal／100 g，並保留 ±15% 餐廳配方與用油差異範圍。`
        : `香港食安中心食物研究化驗所（CFS FRL）每 100 g 化驗參考值（${round1(kcalVal)} kcal）。`,
    });
  }

  return {
    sourceKey: SOURCE_KEY,
    defaults: {
      sourceKey: SOURCE_KEY,
      kind: "regional_hk",
      priority: 60,
      provider: "kcalcue-reference",
      sourceLabel: "香港食安中心 CFS",
      attribution: ATTRIBUTION,
      dataNotice: DATA_NOTICE,
      brandAliases: [],
      retrievedAt,
    },
    entries,
    meta: { totalRows: rowLimit - 2, skipped },
  };
}
