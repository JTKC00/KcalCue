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

V0.1 使用 `LocalNutritionProvider` 支援 Demo及常見手動輸入，所有資料在 code/UI 明確標示為「本地示範／參考資料，並非即時官方資料」。`NutritionProvider` interface 可日後增加 USDA、Open Food Facts 或自建資料庫 adapter。

找不到 food 或 unit conversion 時，採 partial result 並明確排除該項，而不是請 AI 補一個看似精確數值。

## 6. Deterministic range calculation

所有 kcal、Protein、Carbs、Fat 都以 `per100g × portion range` 的 application logic 計算。份量 quick presets 永遠由原始 estimate baseline 計算，避免反覆點按造成倍數累積。單位轉換先經 nutrition profile 的 `gramsPerUnit`，沒有 conversion 就清楚標示不可計算。

整餐 confidence 採最弱食物的 recognition/portion confidence，這是刻意保守的產品決定，避免平均值掩蓋一項高度不確定的食物。

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
