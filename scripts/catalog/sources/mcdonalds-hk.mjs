import {
  cleanName,
  fetchJson,
  fetchText,
  round1,
  runPool,
  uniqueStrings,
} from "../shared.mjs";

export const SOURCE_KEY = "mcdonalds-hk";
const BASE_URL = "https://www.mcdonalds.com.hk";
const CONCURRENCY = 6;

const CATEGORIES = [
  "burgers",
  "breakfast-platter-and-twisty-pasta",
  "salads",
  "desserts",
  "beverages",
  "condiment",
  "happy-meals",
  "snacks-and-sides",
];

const BRAND_ALIASES = [
  "麥當勞", "麦当劳", "香港麥當勞", "香港麦当劳",
  "m記", "m记", "老麥", "老麦",
  "mcdonald's", "mcdonalds", "mcdonald", "mcd",
];

const DATA_NOTICE =
  "KcalCue 參考營養資料；數值來自香港麥當勞官網公開標準配方資料，並非此餐的化驗結果。";
const ATTRIBUTION =
  "McDonald's Hong Kong 官方營養資料（mcdonalds.com.hk）；按標準配方計算，實際數值可能因門市製作、醬汁或凍飲冰量而略有差異。";

const ITEM_OVERRIDES = {
  "200035": { exclusive: ["巨無霸", "巨无霸", "big mac"], branded: ["巨無霸漢堡"] },
  "200037": { exclusive: ["雙層芝士孖堡", "双层芝士孖堡", "孖芝"], branded: ["double cheeseburger"] },
  "200201": { displayName: "Double 雙層芝士孖堡", exclusive: ["double 雙層芝士孖堡", "double 双层芝士孖堡", "double double cheeseburger", "ddcb"], branded: [] },
  "200038": { exclusive: ["魚柳飽", "魚柳包", "鱼柳包", "filet-o-fish", "filet o fish", "filet ofish"], branded: [] },
  "200041": { exclusive: ["脆辣雞腿飽", "脆辣雞腿包", "脆辣鸡腿包", "mcspicy", "mcspicy chicken filet", "mcspicy chicken fillet"], branded: [] },
  "200162": { exclusive: ["板燒雞腿飽", "板燒雞腿包", "板烧鸡腿包", "gcb"], branded: [] },
  "200197": { displayName: "Double板燒雞腿飽", exclusive: ["double板燒雞腿飽", "double 板燒雞腿飽", "雙層板燒雞腿飽", "双层板烧鸡腿包", "double gcb", "dgcb"], branded: [] },
  "200198": { displayName: "板燒雞腿飽（走醬）", exclusive: ["板燒雞腿飽 走醬", "走醬板燒雞腿飽", "板燒雞腿包 走醬", "gcb sauce-free", "gcb sauce free", "gcb no sauce"], branded: [] },
  "200199": { displayName: "Double板燒雞腿飽（走醬）", exclusive: ["double板燒雞腿飽 走醬", "走醬雙層板燒雞腿飽", "雙層板燒雞腿飽 走醬", "double gcb sauce-free", "double gcb sauce free", "dgcb no sauce"], branded: [] },
  "200042": { exclusive: ["豬柳漢堡", "豬柳漢堡飽", "猪柳汉堡", "sausage mcmuffin"], branded: [] },
  "200043": { exclusive: ["豬柳蛋漢堡", "豬柳蛋漢堡飽", "猪柳蛋汉堡", "豬柳蛋", "sausage mcmuffin with egg"], branded: [] },
  "200031": { exclusive: ["麥芝蛋飽", "麥芝蛋包", "麦芝蛋包"], branded: ["egg & cheese burger", "egg cheese burger"] },
  "200034": { exclusive: ["火腿扒芝士漢堡", "火腿扒芝士漢堡飽"], branded: ["ham n' cheese burger", "ham n cheese burger", "ham and cheese burger"] },
  "200039": { exclusive: [], branded: ["漢堡飽", "漢堡包", "漢堡", "hamburger"] },
  "200036": { exclusive: [], branded: ["芝士漢堡飽", "芝士漢堡包", "芝士漢堡", "cheeseburger"] },
  "200163": { exclusive: ["蘑菇安格斯", "cheesy champignon angus burger"], branded: [] },
  "200164": { exclusive: ["芝士安格斯", "angus original"], branded: [] },
  "200045": { exclusive: ["麥樂雞 (4件)", "麦乐鸡 (4件)", "4件麥樂雞", "4件麦乐鸡", "chicken mcnuggets (4pcs)", "mcnuggets 4pcs", "4pcs chicken mcnuggets"], branded: [] },
  "200046": { exclusive: ["麥樂雞 (6件)", "麦乐鸡 (6件)", "6件麥樂雞", "6件麦乐鸡", "chicken mcnuggets (6pcs)", "mcnuggets 6pcs", "6pcs chicken mcnuggets"], branded: [] },
  "200047": { exclusive: ["麥樂雞 (9件)", "麦乐鸡 (9件)", "9件麥樂雞", "9件麦乐鸡", "chicken mcnuggets (9pcs)", "mcnuggets 9pcs", "9pcs chicken mcnuggets"], branded: [] },
  "200055": { exclusive: ["脆香雞翼 (2件)", "脆香鸡翼 (2件)", "2件脆香雞翼", "2件脆香鸡翼", "mcwings (2pcs)", "2pcs mcwings"], branded: [] },
  "200056": { exclusive: ["脆香雞翼 (4件)", "脆香鸡翼 (4件)", "4件脆香雞翼", "4件脆香鸡翼", "mcwings (4pcs)", "4pcs mcwings"], branded: [] },
  "200200": { displayName: "滋味分享盒 (6件麥樂雞+4件脆香雞翼)", exclusive: ["滋味分享盒", "滋味分享盒 (6件麥樂雞+4件脆香雞翼)", "tasty sharing box"], branded: ["sharing box"] },
  "200051": { exclusive: [], branded: ["大薯條", "大薯条", "薯條 (大)", "fries (l)", "large fries", "french fries (l)", "large french fries"] },
  "200052": { exclusive: [], branded: ["中薯條", "中薯条", "薯條 (中)", "fries (m)", "medium fries", "french fries (m)", "medium french fries"] },
  "200053": { exclusive: [], branded: ["細薯條", "细薯条", "小薯條", "薯條 (細)", "fries (s)", "small fries", "french fries (s)", "small french fries"] },
  "200009": { exclusive: [], branded: ["脆薯餅", "薯餅", "脆薯饼", "薯饼", "hash browns", "hash brown"] },
  "200001": { exclusive: ["粒粒粟米杯"], branded: ["粟米杯", "fresh corn cup", "corn cup"], extraUnits: ["cup"] },
  "200000": { exclusive: ["粒粒粟米杯 (細)", "細粒粒粟米杯"], branded: ["細粟米杯", "fresh corn cup (s)", "small corn cup"], extraUnits: ["cup"] },
  "200007": { exclusive: [], branded: ["藍莓高鈣低脂乳酪", "藍莓乳酪", "hi-calcium low fat blueberry yoghurt", "blueberry yoghurt", "blueberry yogurt"], extraUnits: ["cup"] },
  "200008": { exclusive: [], branded: ["精選早晨套餐", "精选早晨套餐", "deluxe breakfast"] },
  "200010": { exclusive: [], branded: ["熱香餅 (2件)", "热香饼 (2件)", "2件熱香餅", "hotcakes (2pcs)", "hotcake 2pcs"] },
  "200190": { exclusive: [], branded: ["熱香餅 (3件)", "热香饼 (3件)", "3件熱香餅", "hotcakes (3pcs)"] },
  "200191": { exclusive: ["熱香餅精選套餐", "热香饼精选套餐", "hotcakes deluxe breakfast"], branded: [] },
  "200192": { exclusive: ["珍寶套餐", "珍宝套餐", "jumbo breakfast"], branded: [] },
  "200024": { exclusive: ["板燒雞腿扭扭粉 (豬骨湯)", "豬骨湯板燒雞腿扭扭粉", "grilled chicken twisty pasta (tonkotsu)"], branded: [], extraUnits: ["bowl"] },
  "200026": { exclusive: ["火腿扒蛋扭扭粉 (豬骨湯)", "豬骨湯火腿扒蛋扭扭粉", "ham n' egg twisty pasta (tonkotsu)"], branded: [], extraUnits: ["bowl"] },
  "200028": { exclusive: ["豬柳蛋扭扭粉 (豬骨湯)", "豬骨湯豬柳蛋扭扭粉", "sausage n' egg twisty pasta (tonkotsu)"], branded: [], extraUnits: ["bowl"] },
  "200194": { exclusive: ["火腿扒蛋扭扭粉 (原味)", "原味火腿扒蛋扭扭粉", "火腿扒蛋扭扭粉", "ham n' egg twisty pasta (original)", "ham n' egg twisty pasta"], branded: [], extraUnits: ["bowl"] },
  "200195": { exclusive: ["豬柳蛋扭扭粉 (原味)", "原味豬柳蛋扭扭粉", "豬柳蛋扭扭粉", "sausage n' egg twisty pasta (original)", "sausage n' egg twisty pasta"], branded: [], extraUnits: ["bowl"] },
  "200003": { exclusive: [], branded: ["凱撒沙律", "凯撒沙律", "caesar salad"], extraUnits: ["bowl"] },
  "200004": { exclusive: [], branded: ["烤雞凱撒沙律", "烤鸡凯撒沙律", "grilled chicken caesar salad", "chicken caesar salad"], extraUnits: ["bowl"] },
  "200044": { exclusive: [], branded: ["蘋果批", "苹果批", "蘋果派", "apple pie"] },
  "200060": { exclusive: [], branded: ["朱古力新地", "hot fudge sundae", "chocolate sundae"], extraUnits: ["cup"] },
  "200061": { exclusive: [], branded: ["士多啤梨新地", "草莓新地", "strawberry sundae"], extraUnits: ["cup"] },
  "200062": { exclusive: ["新地筒"], branded: ["twist cone"] },
  "200063": { exclusive: ["曲奇麥旋風", "麥旋風", "麦旋风", "oreo mcflurry", "mcflurry"], branded: [], extraUnits: ["cup"] },
  "200069": { exclusive: [], branded: ["士多啤梨奶昔 (大)", "大士多啤梨奶昔", "shakes - strawberry (l)", "strawberry shake (l)", "large strawberry shake"], isBeverage: true },
  "200070": { exclusive: [], branded: ["士多啤梨奶昔 (細)", "細士多啤梨奶昔", "shakes - strawberry (s)", "strawberry shake (s)", "small strawberry shake"], isBeverage: true },
  "200073": { exclusive: [], branded: ["可口可樂汽水 (細)", "細可口可樂", "可口可樂 (細)", "細可樂", "可樂 (細)", "coca-cola (s)", "small coke", "small coca-cola"], isBeverage: true },
  "200079": { exclusive: [], branded: ["凍新鮮檸檬茶", "凍檸茶", "凍檸檬茶", "iced fresh lemon tea", "iced lemon tea"], isBeverage: true },
  "200085": { exclusive: [], branded: ["熱新鮮檸檬茶", "熱檸茶", "熱檸檬茶", "hot fresh lemon tea", "hot lemon tea"], isBeverage: true },
  "200186": { exclusive: [], branded: ["熱新鮮檸檬水", "熱檸水", "熱檸檬水", "hot fresh lemon water", "hot lemon water"], isBeverage: true },
  "200088": { exclusive: [], branded: ["熱朱古力", "熱巧克力", "hot chocolate"], isBeverage: true },
  "200184": { exclusive: [], branded: ["凍港式奶茶 (大)", "大凍港式奶茶", "凍港式奶茶", "凍奶茶 (大)", "iced local milk tea (large)", "iced local milk tea (l)", "iced milk tea (large)"], isBeverage: true },
  "200099": { exclusive: [], branded: ["高鈣低脂牛奶飲品", "高鈣低脂奶", "低脂牛奶飲品", "hi-calcium low fat milk drink", "low fat milk drink"], isBeverage: true },
  "200196": { displayName: "美粒果蘋果汁飲品", exclusive: [], branded: ["美粒果蘋果汁飲品", "美粒果蘋果汁", "蘋果汁", "minute maid apple juice drink", "minute maid apple juice", "apple juice"], isBeverage: true },
  "200097": { exclusive: [], branded: ["飛雪礦物質水 (500毫升)", "飛雪礦物質水 500毫升", "飛雪礦物質水 500ml", "bonaque mineralized water 500ml"], isBeverage: true, fixedServingSize: 500 },
  "200098": { exclusive: [], branded: ["飛雪礦物質水 (700毫升)", "飛雪礦物質水 700毫升", "飛雪礦物質水 700ml", "bonaque mineralized water 700ml"], isBeverage: true, fixedServingSize: 700 },
  "200005": { exclusive: [], branded: ["丘比凱撒沙律汁", "凱撒沙律汁", "凱撒沙律醬", "kewpie caesar salad dressing", "caesar salad dressing"] },
  "200006": { exclusive: [], branded: ["丘比焙煎芝麻沙律汁", "焙煎芝麻沙律汁", "芝麻沙律汁", "胡麻醬", "kewpie roasted sesame dressing", "roasted sesame dressing"] },
  "200014": { exclusive: [], branded: ["提子果醬", "葡萄果醬", "grape jam"] },
  "200015": { exclusive: [], branded: ["熱香餅糖漿", "糖漿", "hotcake syrup"] },
  "200048": { exclusive: [], branded: ["燒烤醬", "barbeque sauce", "bbq sauce"] },
  "200049": { exclusive: [], branded: ["芥末醬", "hot mustard sauce", "mustard sauce"] },
  "200050": { exclusive: [], branded: ["甜酸醬", "甜酸醬包", "sweet n sour sauce", "sweet and sour sauce"] },
  "200054": { exclusive: [], branded: ["茄汁", "番茄醬", "ketchup"] },
  "200187": { displayName: "牛油", exclusive: [], branded: ["植物牛油", "牛油", "butter", "whipped butter"] },
};

function parseNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toUpperCase() === "N/A") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function inferServingSize(nutrientsMap) {
  const ratios = [];
  for (const key of ["energy_kcal", "carbohydrate", "fat", "protein"]) {
    const entry = nutrientsMap.get(key);
    if (entry && entry.value !== null && entry.per100 !== null && entry.value > 0 && entry.per100 >= 5) {
      ratios.push((entry.value / entry.per100) * 100);
    }
  }
  if (ratios.length > 0) return Math.round(median(ratios));
  const energy = nutrientsMap.get("energy_kcal");
  if (energy && energy.value !== null && energy.per100 !== null && energy.value > 0 && energy.per100 > 0) {
    return Math.round((energy.value / energy.per100) * 100);
  }
  return null;
}

function inferCategoryAndPrep(categorySlugs, apiCategory, isBeverage) {
  if (categorySlugs.includes("condiment") || apiCategory === "配料") {
    return { category: "sauce", preparations: ["sauced", "unknown"], composite: false };
  }
  if (isBeverage || categorySlugs.includes("beverages") || apiCategory === "飲品") {
    return { category: "mixed", preparations: ["raw", "unknown"], composite: true };
  }
  if (categorySlugs.includes("burgers") || apiCategory === "飽類") {
    return { category: "mixed", preparations: ["cooked", "grilled", "deep_fried", "unknown"], composite: true };
  }
  if (categorySlugs.includes("breakfast-platter-and-twisty-pasta") || apiCategory === "早晨拼盤及扭扭粉") {
    return { category: "mixed", preparations: ["cooked", "boiled", "pan_fried", "unknown"], composite: true };
  }
  if (categorySlugs.includes("salads") || apiCategory === "沙律") {
    return { category: "mixed", preparations: ["raw", "grilled", "unknown"], composite: true };
  }
  if (categorySlugs.includes("desserts") || apiCategory === "甜品") {
    return { category: "mixed", preparations: ["cooked", "deep_fried", "raw", "unknown"], composite: true };
  }
  return { category: "fried", preparations: ["deep_fried", "cooked", "unknown"], composite: true };
}

function extractRscText(html) {
  const chunks = [];
  for (const match of html.matchAll(/self\.__next_f\.push\(\[1,(".*?")\]\)/gs)) {
    try { chunks.push(JSON.parse(match[1])); } catch { /* ignore */ }
  }
  return chunks.join("\n");
}

function extractPageTitle(html) {
  const match = html.match(/<title>(.*?)<\/title>/i);
  if (!match) return "";
  return match[1]
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s*\|\s*McDonald's\s*$/i, "")
    .trim();
}

export async function fetchMcDonaldsHkSource(retrievedAt) {
  const slugToCategories = new Map();
  for (const category of CATEGORIES) {
    const html = await fetchText(`${BASE_URL}/nutrition_category/${category}/`);
    const rsc = extractRscText(html);
    for (const match of rsc.matchAll(/"href":"(\/product\/[^"]+)"/g)) {
      const slug = match[1];
      if (!slugToCategories.has(slug)) slugToCategories.set(slug, new Set());
      slugToCategories.get(slug).add(category);
    }
  }

  const slugs = [...slugToCategories.keys()];
  const inspected = await runPool(slugs, CONCURRENCY, async (slug) => {
    const [zhHtml, enHtml] = await Promise.all([
      fetchText(`${BASE_URL}${slug}`),
      fetchText(`${BASE_URL}/en${slug}`).catch(() => ""),
    ]);
    const rsc = extractRscText(zhHtml);
    const nids = [...new Set([...rsc.matchAll(/"nutritionId":"(\d+)"/g)].map((m) => m[1]))];
    return {
      slug,
      nids,
      zhTitle: extractPageTitle(zhHtml),
      enTitle: extractPageTitle(enHtml),
      categorySlugs: [...slugToCategories.get(slug)],
    };
  });

  const byNid = new Map();
  const missingNutritionIdPages = [];
  for (const page of inspected) {
    if (page.nids.length === 0) {
      missingNutritionIdPages.push(page.slug);
      continue;
    }
    for (const nid of page.nids) {
      const existing = byNid.get(nid);
      if (existing) {
        for (const cat of page.categorySlugs) existing.categorySlugs.add(cat);
      } else {
        byNid.set(nid, {
          nid,
          zhTitle: page.zhTitle,
          enTitle: page.enTitle,
          categorySlugs: new Set(page.categorySlugs),
        });
      }
    }
  }

  const nids = [...byNid.keys()].sort();
  const fetched = await runPool(nids, CONCURRENCY, async (nid) => {
    const [chRes, enRes] = await Promise.all([
      fetchJson(`${BASE_URL}/api/nutrition/item?item=${nid}&language=ch`),
      fetchJson(`${BASE_URL}/api/nutrition/item?item=${nid}&language=en`).catch(() => ({ data: {} })),
    ]);
    const meta = byNid.get(nid);
    return {
      nid,
      ch: chRes.data ?? {},
      en: enRes.data ?? {},
      zhTitle: meta.zhTitle,
      enTitle: meta.enTitle,
      categorySlugs: [...meta.categorySlugs],
    };
  });

  const entriesById = new Map();
  const servingById = new Map();
  let skipped = 0;

  for (const item of fetched) {
    const { nid, ch, en, zhTitle, enTitle, categorySlugs } = item;
    const override = ITEM_OVERRIDES[nid] ?? {};
    const nutrientsMap = new Map();
    for (const nutrient of ch.nutrients ?? []) {
      nutrientsMap.set(nutrient.id, {
        value: parseNumber(nutrient.value),
        per100: parseNumber(nutrient.valuePer100g),
      });
    }

    const kcal = nutrientsMap.get("energy_kcal");
    const protein = nutrientsMap.get("protein");
    const carbs = nutrientsMap.get("carbohydrate");
    const fat = nutrientsMap.get("fat");
    const sugar = nutrientsMap.get("sugar");

    if (!kcal || kcal.value === null) { skipped += 1; continue; }
    const carbVal = carbs?.value ?? (sugar?.value === 0 && fat?.value !== null && fat.value * 9 >= kcal.value * 0.9 ? 0 : null);
    if (protein?.value === null || protein?.value === undefined || carbVal === null || fat?.value === null || fat?.value === undefined) {
      skipped += 1;
      continue;
    }

    const hasPer100 = kcal.per100 !== null && protein.per100 !== null && carbs?.per100 !== null && fat.per100 !== null;
    const isBeverage = Boolean(override.isBeverage) || categorySlugs.includes("beverages") || ch.category === "飲品";
    const { category, preparations, composite } = inferCategoryAndPrep(categorySlugs, ch.category, isBeverage);
    const displayName = cleanName(override.displayName || zhTitle || ch.marketingName || ch.name);
    const id = `${SOURCE_KEY}-${nid}`;

    let kcalOut; let proteinOut; let carbsOut; let fatOut;
    let gramsPerUnit;
    let densityBasis;

    if (hasPer100) {
      kcalOut = round1(kcal.per100);
      proteinOut = round1(protein.per100);
      carbsOut = round1(carbs.per100);
      fatOut = round1(fat.per100);
      const servingSize = override.fixedServingSize ?? inferServingSize(nutrientsMap);
      gramsPerUnit = isBeverage ? { ml: 1, g: 1 } : { g: 1 };
      if (servingSize && servingSize > 0) {
        servingById.set(id, servingSize);
        gramsPerUnit.piece = servingSize;
        if (isBeverage) gramsPerUnit.cup = servingSize;
        for (const extra of override.extraUnits ?? []) gramsPerUnit[extra] = servingSize;
      }
      const unitLabel = isBeverage ? "100 ml" : "100 g";
      const servingUnit = isBeverage ? "ml" : "g";
      densityBasis = servingSize
        ? `香港麥當勞官網標準配方參考值（每 ${unitLabel}）；標準單份約 ${servingSize} ${servingUnit}（約 ${Math.round(kcal.value)} kcal）。`
        : `香港麥當勞官網標準配方參考值（每 ${unitLabel}）。`;
    } else {
      kcalOut = round1(kcal.value);
      proteinOut = round1(protein.value);
      carbsOut = round1(carbVal);
      fatOut = round1(fat.value);
      gramsPerUnit = { piece: 100 };
      densityBasis = `香港麥當勞官網只提供每包／每份標準數值（約 ${Math.round(kcal.value)} kcal／份），未提供每 100 g 密度，僅支援按「件」計算。`;
    }

    const exclusiveAliases = uniqueStrings(override.exclusive ?? []);
    const brandedAliases = uniqueStrings([
      ...(override.branded ?? []),
      ...(override.exclusive ? [] : [displayName, zhTitle, ch.marketingName, enTitle, en.marketingName, ch.name]),
    ]);

    entriesById.set(id, {
      id,
      displayName,
      canonicalName: id,
      category,
      preparations,
      composite,
      ...(exclusiveAliases.length > 0 ? { exclusiveAliases } : {}),
      ...(brandedAliases.length > 0 ? { brandedAliases } : {}),
      kcal: kcalOut,
      protein: proteinOut,
      carbs: carbsOut,
      fat: fatOut,
      gramsPerUnit,
      sourceId: `${SOURCE_KEY}:${nid}`,
      densityBasis,
    });
  }

  // Derived helpers: per-piece McNuggets, per-piece McWings, per-piece Hotcakes, gram-only Fries.
  // Destructure optional alias keys instead of assigning undefined (Firestore SDK rejects undefined values).
  const nuggets6 = entriesById.get(`${SOURCE_KEY}-200046`);
  const nuggets6Serving = servingById.get(`${SOURCE_KEY}-200046`);
  if (nuggets6 && nuggets6Serving) {
    const { brandedAliases: _omitBranded, ...nuggetsBase } = nuggets6;
    void _omitBranded;
    const pieceGrams = Math.round(nuggets6Serving / 6);
    const id = `${SOURCE_KEY}-mcnuggets-single`;
    entriesById.set(id, {
      ...nuggetsBase,
      id,
      displayName: "麥樂雞",
      canonicalName: id,
      exclusiveAliases: ["麥樂雞", "麦乐鸡", "chicken mcnuggets", "mcnuggets", "chicken mcnugget", "mcnugget"],
      gramsPerUnit: { g: 1, piece: pieceGrams },
      sourceId: `${SOURCE_KEY}:200046:per-piece`,
      sourceName: "香港麥當勞官方營養資料：麥樂雞（按件換算）",
      densityBasis: `依據香港麥當勞官網 6 件麥樂雞標準配方（每 100 g 密度相同），單件約 ${pieceGrams} g。`,
    });
  }

  const wings2 = entriesById.get(`${SOURCE_KEY}-200055`);
  const wings2Serving = servingById.get(`${SOURCE_KEY}-200055`);
  if (wings2 && wings2Serving) {
    const { brandedAliases: _omitBranded, ...wingsBase } = wings2;
    void _omitBranded;
    const pieceGrams = Math.round(wings2Serving / 2);
    const id = `${SOURCE_KEY}-mcwings-single`;
    entriesById.set(id, {
      ...wingsBase,
      id,
      displayName: "脆香雞翼",
      canonicalName: id,
      exclusiveAliases: ["脆香雞翼", "脆香鸡翼", "mcwings", "mcwing"],
      gramsPerUnit: { g: 1, piece: pieceGrams },
      sourceId: `${SOURCE_KEY}:200055:per-piece`,
      sourceName: "香港麥當勞官方營養資料：脆香雞翼（按件換算）",
      densityBasis: `依據香港麥當勞官網 2 件脆香雞翼標準配方（每 100 g 密度相同），單件約 ${pieceGrams} g。`,
    });
  }

  const hotcakes2 = entriesById.get(`${SOURCE_KEY}-200010`);
  const hotcakes2Serving = servingById.get(`${SOURCE_KEY}-200010`);
  if (hotcakes2 && hotcakes2Serving) {
    const { exclusiveAliases: _omitExclusive, ...hotcakesBase } = hotcakes2;
    void _omitExclusive;
    const pieceGrams = Math.round(hotcakes2Serving / 2);
    const id = `${SOURCE_KEY}-hotcakes-single`;
    entriesById.set(id, {
      ...hotcakesBase,
      id,
      displayName: "熱香餅（單件）",
      canonicalName: id,
      brandedAliases: ["熱香餅", "热香饼", "hotcakes", "hotcake"],
      gramsPerUnit: { g: 1, piece: pieceGrams },
      sourceId: `${SOURCE_KEY}:200010:per-piece`,
      sourceName: "香港麥當勞官方營養資料：熱香餅（按件換算）",
      densityBasis: `依據香港麥當勞官網 2 件熱香餅標準配方（每 100 g 密度相同），單件約 ${pieceGrams} g。`,
    });
  }

  const friesM = entriesById.get(`${SOURCE_KEY}-200052`);
  if (friesM) {
    const { exclusiveAliases: _omitExclusive, ...friesBase } = friesM;
    void _omitExclusive;
    const id = `${SOURCE_KEY}-fries-generic`;
    entriesById.set(id, {
      ...friesBase,
      id,
      displayName: "麥當勞薯條",
      canonicalName: id,
      brandedAliases: ["薯條", "薯条", "fries", "french fries"],
      gramsPerUnit: { g: 1 },
      sourceId: `${SOURCE_KEY}:200052:density`,
      sourceName: "香港麥當勞官方營養資料：薯條（每 100 g）",
      densityBasis: "香港麥當勞細／中／大薯條每 100 g 密度相同；未指定尺寸時僅支援按克重（g）計算，按份請註明細／中／大薯條。",
    });
  }

  return {
    sourceKey: SOURCE_KEY,
    defaults: {
      sourceKey: SOURCE_KEY,
      kind: "branded",
      priority: 100,
      provider: "kcalcue-reference",
      sourceLabel: "香港麥當勞官方營養資料",
      attribution: ATTRIBUTION,
      dataNotice: DATA_NOTICE,
      brandAliases: BRAND_ALIASES,
      retrievedAt,
    },
    entries: [...entriesById.values()],
    meta: { productPages: slugs.length, skipped, missingNutritionIdPages },
  };
}
