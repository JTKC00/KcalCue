# KcalCue V0.1 — Autonomous Decisions

日期：2026-08-13（Asia/Hong_Kong）

## 1. 使用 Next.js 單體 Web App

選擇 Next.js App Router + TypeScript，讓 responsive frontend、server-only API route、PWA metadata 及 production build 留在一個專案。這是比獨立 frontend/backend 更簡單、容易本機執行及測試的 V0.1 路線，同時保留清楚 module boundaries，沒有建立不必要 microservices。

## 2. Provider-neutral food vision boundary

定義 `FoodVisionProvider`，輸入只有受支援的 image bytes + MIME type，輸出只有 validated `FoodAnalysis` domain model。

- `GeminiFoodVisionProvider` 擁有 Google SDK、prompt、model config、structured output、timeouts 及 error translation。
- `DemoFoodVisionProvider` 回傳固定且 validated 的示範餐。
- UI、nutrition、calculation 及 confidence code 不知道 provider 品牌。

這令未來加入 OpenAI、本地模型、mock 或其他 provider 時，不需要改 result flow。

## 3. 預設 Gemini model：`gemini-3.5-flash-lite`

根據 2026-08-13 查閱的 Google 官方 model page，該 GA model 支援 image input、text output 及 structured output，官方定位為低延遲、成本效益優先的 multimodal model，適合照片分析 MVP。模型名稱只在 `src/lib/server/env.ts` 有一個 fallback，並可由 `GEMINI_MODEL` 覆寫。

使用現行 GA `@google/genai`，沒有採用已 deprecated 的 `@google/generative-ai`。本機安裝的 SDK 型別亦確認 `responseMimeType` + `responseJsonSchema` 是 released TypeScript surface。

## 4. Server 再驗證 AI structured output

Gemini JSON Schema 只用來約束生成；application 不信任模型一定正確。回覆仍要經 JSON parse 及 Zod validation，並額外檢查：

- portion max 不可小於 min
- confidence 必須在 0–1
- success 至少有一個 food
- unable-to-identify 不可包含猜測 food

任何不合規格回覆都成為可重試的 `invalid_response` state。

## 5. Nutrition 與 AI 完全分開

Gemini 只提供可見食物身份、份量範圍與不確定性。kcal / Protein / Carbs / Fat 永遠由 Nutrition Provider 的參考資料經 application logic 計算，不接受模型自行填數。

## 6. Deterministic range calculation

最終範圍同時反映份量不確定性與營養密度不確定性：

`min = portionMin × densityMin / 100`  
`max = portionMax × densityMax / 100`

若可靠資料只有單點值，則 `min = max`。份量 presets 永遠由原始 estimate baseline 計算。單位轉換先經 profile 的 `gramsPerUnit`，沒有 conversion 就不計入總數。

---

## 12. 舊 Nutrition Layer 的限制（2026-08-19 重構前）

重構前 `NutritionProvider.findByName` 只做 NFKC／小寫後的 **整串 exact match**（id、displayName、aliases）。`NutritionProfile.nutrientsPer100g` 只有單一 point。餐範圍只是 `單一密度 × 份量 range`。Result UI 用 recognition∩portion 的最弱值當「整體可信程度」，營養配對失敗時仍可能顯示中等可信度，造成「暫未能計算」與「可信程度：中等」並存。

這令 Gemini 的自然描述（紅米白飯、香煎雞胸肉、炒什錦蔬菜、番茄風味醬汁）全部 miss。

## 13. Canonical identity 與 resolution pipeline

Display name 不再當 database key。`canonicalizeFood()` 用詞彙（雞胸、紅米、炒、番茄、醬汁…）抽出：

`CanonicalFoodIdentity { canonicalName, category, preparation, qualifiers }`

Resolver 再對 catalog 評分，並區分：

- `exact_canonical`
- `strong_synonym`
- `category_preparation`
- `approximate_generic`
- `unresolved`

只有 **high / medium** 的 match 計入餐總數。low 或組合菜式（炒飯、咖喱、火鍋、pizza 等）若沒有專屬 profile，維持 unresolved。不把每個 Gemini 字串寫成 alias。

## 14. Nutrition 資料來源

評估結果（2026-08-19）：

| 來源 | 可信度 | 通用／熟食 | 授權 | Key | 港式／亞洲 | 決定 |
|---|---|---|---|---|---|---|
| USDA FoodData Central | 高 | 強 | 公有領域／CC0 | 可選，約 1000 req/h | 弱 | 參考基準 + 可選 live fallback |
| Open Food Facts | 中（眾包包裝食品） | 弱於 generic cooked | ODbL 需署名／share-alike | 無，但 10–15 req/min | 包裝食品較好 | 本輪不採用 |
| 僅 alias 擴充 | 低 | 無泛化 | n/a | 無 | 只覆蓋寫死名稱 | 拒絕作為完成條件 |

**本輪選擇：**

1. **主路徑**：KcalCue curated reference catalog。密度來自 USDA 公開熟食／原料值；有烹調不確定性時用已記錄的 min/max band，不是 LLM 編造。
2. **可選**：`NUTRITION_API_KEY`（USDA FDC）只用於本地 unresolved 的 Live 食物。沒有 key 時 App 仍可啟動、Demo、local fallback、partial result。
3. 解析結果 cache 在 `EditableFoodItem.nutritionMatch`。改份量只重算，不重查 Gemini 或 Nutrition API。

## 15. Partial coverage threshold

- `complete`：全部項目 high/medium
- `partial`：已計入項目 ≥ 75%，顯示總數並寫明「只包括 N / M 項」
- `insufficient`：已計入 > 0 但 < 75%，**不顯示整餐總數**
- `none`：沒有可計入項目

4 項餐中 3 項可靠 → 顯示總數。2 / 4 → 不顯示總數。

## 16. HEIC / HEIF

仍是已知高優先 product gap。本 sprint 範圍是 Nutrition Foundation；HEIC 留待獨立 sprint，避免拖延 P0。

## 7. 一套 Demo / Live UI flow

沒有 API key 時由 server factory 選 `DemoFoodVisionProvider`；UI 仍經同一 `/api/analyze` response schema、result components、nutrition及 editing pipeline。Demo Mode 始終顯眼標示，而且不會假裝分析使用者相片。

## 8. 圖片安全及大小範圍

V0.1 支援 browser 可靠預覽的 JPEG、PNG、WebP，限制 10MB，client/server 都會 validation。雖然 Gemini inline image request 官方上限較高，較小 application limit 可降低 latency 及 memory pressure。圖片只在 browser object URL、request memory 及 Gemini request 中短暫存在；沒有 disk/database/storage/history。

## 9. 香港繁體中文及 calm visual system

共用狀態及錯誤文案集中在 `src/content/zh-HK.ts`，元件專屬短文案留在相關元件。視覺採暖白、深綠、柔和珊瑚色，避免醫療 dashboard、健身競賽或 body judgement 語氣。結果層級固定為 kcal range → confidence → breakdown → uncertainty → correction controls。

## 10. 可安裝但不離線假裝分析的 PWA

加入 manifest、app icon、standalone display 及最小 service worker registration；service worker 不 cache 相片、API response 或私人資料。V0.1 不宣稱真正離線 AI 分析能力。

## 11. 固定 lint-compatible toolchain

初次安裝的 TypeScript 7 與目前 `typescript-eslint` 不相容；ESLint 10 亦超出 `eslint-config-next` 內 plugins 的 peer support。根據 npm peer metadata 改用 TypeScript 6.0.3 + ESLint 9.39.5，保留完整 Next/core-web-vitals/a11y lint，而不是停用規則。
