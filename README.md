# KcalCue V0.1

KcalCue 是一個 mobile-first Responsive Web App / PWA：使用者影低或選擇一張餐點相片，KcalCue 會辨認可見食物、估算合理份量範圍，再由獨立營養服務及 deterministic calculation engine 計算卡路里與主要營養素範圍。

> 核心理念：精準呈現不確定性，而不是假裝精準。

主結果不會包裝成單一精確量度，而會顯示「約 565–765 kcal」、可信程度及造成範圍的主要原因。KcalCue 只供一般參考，並非醫療建議。

## 功能

- 手機拍照及裝置圖片選擇
- JPEG / PNG / WebP / HEIC / HEIF 選擇、更換、移除及 client/server validation
- 如果瀏覽器未能預覽 HEIC / HEIF，仍可保留原檔進行分析
- Gemini Live Mode：server-side 圖片理解及 structured JSON output
- 無 `GEMINI_API_KEY` 時自動進入清楚標示的 Demo Mode
- 分離的 `FoodVisionProvider`、`NutritionProvider` 及 calculation engine
- kcal、Protein、Carbs、Fat 範圍及 High / Medium / Low 可信程度
- 可編輯食物名稱、份量及單位；可新增／刪除食物
- 每次修改都在 browser 以 deterministic code 即時重算，不會再次呼叫 AI
- loading、partial、unable-to-identify、invalid response、network/API error 及 retry/fallback states
- 375px 手機、tablet 及 desktop responsive layout
- semantic HTML、keyboard focus、form labels、ARIA loading/error state 及 reduced-motion support
- Web App Manifest、icon 及最小 service worker
- GitHub Actions CI：lint、typecheck、tests、deterministic evaluation 及 production build

## 技術棧

- Next.js 16 App Router + React 19 + TypeScript 6
- Google 官方 [`@google/genai`](https://www.npmjs.com/package/@google/genai) SDK
- Zod 4：server-side structured response validation
- Vitest 4 + Testing Library
- ESLint 9 + `eslint-config-next`

需要 Node.js 20 或以上；本專案使用 npm 11。

## 安裝及執行

```bash
npm install
npm run dev
```

打開 [http://localhost:3000](http://localhost:3000)。如果沒有 `GEMINI_API_KEY`，application 會完整啟動為 Demo Mode。

Production mode：

```bash
npm run build
npm start
```

## Demo Mode

不要建立 `.env.local`，或讓 `GEMINI_API_KEY` 保持空白。UI 會明確顯示：

> 目前為示範模式，未有實際 AI 圖片分析。

使用者選擇的圖片只在本機 browser 作 preview；Demo provider 回傳內建白飯、雞扒、青菜及醬汁資料。Demo 與 Live Mode 共用完全相同的 result UI、nutrition service、confidence system、editing flow 及 calculation engine。

## Gemini Live Mode

1. 複製範例檔：

   ```bash
   cp .env.example .env.local
   ```

2. 在 `.env.local` 填入 server-side key：

   ```dotenv
   GEMINI_API_KEY=your-server-side-key
   GEMINI_MODEL=gemini-3.5-flash-lite
   NUTRITION_API_KEY=
   ```

3. 重新啟動 `npm run dev`。

`.env.local` 已被 `.gitignore` 排除。不要在 browser code、source code、commit、console 或 log 放入 API key。

### 環境變數

| 變數 | 必須 | 預設 | 用途 |
|---|---:|---|---|
| `GEMINI_API_KEY` | Live Mode 必須 | 空白 | 只由 server route 讀取；空白時使用 Demo Mode |
| `GEMINI_MODEL` | 否 | `gemini-3.5-flash-lite` | 集中設定 Gemini multimodal model |
| `NUTRITION_API_KEY` | 否 | 空白 | 可選 USDA FoodData Central key；空白時只用本地 reference |

預設模型選擇原因記錄在 [DECISIONS.md](./DECISIONS.md)。Google 官方資料：[model page](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite)、[structured output](https://ai.google.dev/gemini-api/docs/structured-output)、[image understanding](https://ai.google.dev/gemini-api/docs/generate-content/image-understanding)。

## Architecture

```text
Browser image input
        │
        ▼
POST /api/analyze  (server-only, transient image bytes + container sniffing)
        │
        ▼
FoodVisionProvider
  ├── GeminiFoodVisionProvider  ── image → structured estimate
  └── DemoFoodVisionProvider    ── deterministic demo estimate
        │
        ▼
Validated FoodAnalysis domain schema
        │
        ▼
NutritionService → NutritionProvider
                     └── LocalNutritionProvider
                           ├── canonicalizeFood
                           ├── resolveNutritionMatch
                           └── optional USDA FDC fallback (`/api/nutrition/resolve`)
        │
        ▼
Deterministic calculation engine
        │
        ▼
Shared result UI + editing + immediate recalculation
```

主要邊界：

- `src/lib/providers/food-vision/`：只負責「圖片 → structured food analysis」。Gemini SDK、prompt、timeout 及 API error mapping 不會滲入 UI。
- `src/lib/domain/`：provider-neutral schema、confidence、portion adjustment 及 unit transformation。
- `src/lib/nutrition/`：營養 provider interface、本地 reference adapter 及 deterministic range calculation。
- `src/app/api/analyze/route.ts`：server-only input validation、provider selection 及 public-safe error codes。
- `src/components/`：一套共用 Demo/Live UI flow。
- `src/content/zh-HK.ts`：集中維護共用狀態及錯誤文案；元件專屬短文案留在相關元件。

未來新增 `OpenAIFoodVisionProvider`、本地模型或另一個 multimodal provider 時，只需實作 `FoodVisionProvider` 並在 factory 選擇；Result UI、meal domain model、nutrition service、confidence 及 calculation engine 不需要重寫。

## Nutrition data

AI 只辨認食物及估算份量，不提供正式 kcal／macro。Nutrition layer 會：

1. 把 `displayName` 轉成 canonical identity（與 UI 名稱分開）
2. 以 synonym／category／preparation 做 resolution，而不是只做 exact alias
3. 給每個 match 可信程度；low 或無法代表的組合菜式不計入總數
4. 用 **份量範圍 × 營養密度範圍** 做 deterministic calculation
5. 標示資料來源（KcalCue reference／USDA FDC）

本地 catalog 是可離線使用的 reference set。可選的 `NUTRITION_API_KEY`（USDA FoodData Central）只在本地無法可靠配對時由 server 查詢。沒有這把 key 時，App、Demo 與 partial result 仍然可用。

修改份量或 preset 只重算，不會再次呼叫 Gemini 或 Nutrition API。

## Structured AI boundary

Gemini request 使用：

- inline image bytes（raw base64，只在 server memory 建立，不會 log）；Gemini 官方支援 JPEG、PNG、WebP、HEIC 及 HEIF MIME types
- `responseMimeType: "application/json"`
- `responseJsonSchema` 只描述 shape；Zod 仍是權威驗證
- 90 秒 HTTP timeout（Gemini 3.7 Flash thinking）

Server 收到回覆後仍會 `JSON.parse` 並再以 Zod schema 驗證。

## 測試及驗證

```bash
npm run lint
npm run typecheck
npm test
npm run eval
npm run build
```

測試涵蓋 calculation ranges、所有 macros、g/ml/piece conversion、portion presets、confidence mapping、uncertainty de-duplication/fallback、schema validation、Gemini error mapping，以及 Demo analysis → nutrition → user correction → updated result integration pipeline。

`npm run eval` 會獨立執行 representative food / meal cases，驗證 canonical identity、nutrition match、partial / unresolved coverage、composite dish safety、range ordering、非負值及 deterministic recalculation；不使用 Gemini 或 USDA live API，也不建立精確 kcal golden numbers。

GitHub Actions workflow 位於 `.github/workflows/ci.yml`，只使用 `npm ci` 及 deterministic local checks，不需要 `GEMINI_API_KEY`、`NUTRITION_API_KEY` 或 production secrets。

V0.1 baseline 紀錄見 [GOAL_REPORT.md](./GOAL_REPORT.md)；本次 real-world readiness sprint 的完整驗證紀錄見 [OVERNIGHT_REPORT.md](./OVERNIGHT_REPORT.md)。

## Privacy design

- 沒有 database、帳戶、history、analytics 或 public image storage。
- Demo Mode 不會將圖片傳到 server；圖片 object URL 只用於 browser preview，離開／更換後即 revoke。
- Live Mode 圖片以 multipart request 暫時傳到 KcalCue server，再以 inline bytes 傳給 Gemini。
- KcalCue 不寫入圖片檔案、不持久保存 base64，也不記錄 image payload。
- developer-safe timing diagnostics 只記錄 operation、MIME、byte size、計時及 resolved count，不記錄圖片、base64、食物名稱、prompt、個人資料或 secrets。
- 真正 Live Mode 使用時，圖片仍會由 Google Gemini API 處理；部署者應同時審視其帳戶與資料處理條款。

## Known limitations

- 香港／亞洲組合菜式（咖喱、炒飯、火鍋、酒樓菜）coverage 仍然有限；沒有專屬可靠 profile 時會維持 unresolved，而不是套用 generic beef curry。
- USDA 即時查詢是可選 fallback，對港式食物名稱的命中率有限。
- Gemini raw inline request 支援 HEIC / HEIF；Safari 17 起由 WebKit 支援 HEIC 預覽。其他瀏覽器是否能直接顯示相片取決於其 image decoder；KcalCue 會在預覽失敗時保留分析入口，不會為了預覽強制轉檔。目標裝置的完整 browser matrix 仍需持續 QA。
- 單張相片本身無法知道真實重量、隱藏材料、油份、糖份或完整烹調方法；產品刻意以範圍及 uncertainty 表達。
- V0.1 沒有帳戶、歷史紀錄、雲端圖片保存、醫療建議或個人減重目標。
