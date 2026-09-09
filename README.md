# KcalCue — 每日餐點記錄

KcalCue 是一個 mobile-first Responsive Web App / PWA：使用者影低或選擇一張餐點相片，KcalCue 會辨認可見食物、估算合理份量範圍，再由獨立營養服務及 deterministic calculation engine 計算卡路里與主要營養素範圍。

> 核心理念：精準呈現不確定性，而不是假裝精準。

主結果不會包裝成單一精確量度，而會顯示「約 565–765 kcal」、可信程度及造成範圍的主要原因。KcalCue 只供一般參考，並非醫療建議。

## 功能

- 今日／新增／歷史導覽，按日期和餐次保存記錄，修正後更新每日營養範圍
- Firebase Email Link／Google 登入、離線讀寫、重連自動同步與版本衝突保護
- IndexedDB 本機草稿及已下載記錄，離線新增／修改／刪除餐點，重連後自動同步
- PWA 安裝引導、離線殼與每次 build 自動更新版本；更新前先保存草稿
- 雲端與試用帳戶設定見 [SETUP.md](./SETUP.md)，實機驗收見 [ACCEPTANCE.md](./ACCEPTANCE.md)

- 手機拍照及裝置圖片選擇
- JPEG / PNG / WebP / HEIC / HEIF 選擇、更換、移除及 client/server validation
- 如果瀏覽器未能預覽 HEIC / HEIF，仍可保留原檔進行分析
- OpenAI Live Mode：server-side 圖片理解及 structured JSON output
- 無 `OPENAI_API_KEY` 時自動進入清楚標示的 Demo Mode
- 分離的 `FoodVisionProvider`、browser 內的 `LocalNutritionProvider`、可選 server-side `UsdaNutritionClient` 及 calculation engine
- kcal、Protein、Carbs、Fat 範圍及 High / Medium / Low 可信程度
- 可編輯食物名稱、份量及單位；可新增／刪除食物
- 每次修改都在 browser 以 deterministic code 即時重算，不會再次呼叫 AI
- loading（不模擬未知進度，可取消）、partial、unable-to-identify、invalid response、network/API error 及 retry/fallback states
- 375px 手機、tablet 及 desktop responsive layout
- semantic HTML、keyboard focus、form labels、ARIA loading/error state 及 reduced-motion support
- Web App Manifest、SVG／PNG icon、iOS `apple-touch-icon` 及版本化離線 service worker
- GitHub Actions CI：lint、typecheck、tests、deterministic evaluation 及 production build
- `/api/analyze` 及 `/api/nutrition/resolve` 的 in-process per-IP rate limit（公開部署時仍應由 gateway 再限一次）

## 技術棧

- Next.js 16 App Router + React 19 + TypeScript 6
- OpenAI 官方 [`openai`](https://www.npmjs.com/package/openai) SDK + `sharp`（HEIC／HEIF server-side memory conversion）
- Zod 4：server-side structured response validation
- Vitest 4 + Testing Library
- ESLint 9 + `eslint-config-next`

需要符合 `package.json` `engines` 所列的 Node.js 版本（`^22.22.2`、`^24.15.0` 或 `>=26.0.0`）；GitHub Actions CI 固定使用 Node.js 24；本專案使用 npm 11。

## 安裝及執行

```bash
npm install
npm run dev
```

打開 [http://localhost:3000](http://localhost:3000)。如果沒有 `OPENAI_API_KEY`，application 會完整啟動為 Demo Mode。

Production mode：

```bash
npm run build
npm start
```

## Demo Mode

不要建立 `.env.local`，或讓 `OPENAI_API_KEY` 保持空白。UI 會明確顯示：

> 目前為示範模式，未有實際 AI 圖片分析。

使用者選擇的圖片只在本機 browser 作 preview；Demo provider 回傳內建白飯、雞扒、青菜及醬汁資料。Demo 與 Live Mode 共用完全相同的 result UI、nutrition service、confidence system、editing flow 及 calculation engine。

## OpenAI Live Mode

Live 分析需要先登入 Firebase 試用帳戶。請先完成 [SETUP.md](./SETUP.md) 的 Firebase Web App、Email Link／Google 登入與伺服器設定。

1. 複製範例檔：

   ```bash
   cp .env.example .env.local
   ```

2. 在 `.env.local` 填入 server-side key：

   ```dotenv
   OPENAI_API_KEY=your-server-side-key
   OPENAI_MODEL=gpt-5.6-luna
   NUTRITION_API_KEY=
   ```

3. 重新啟動 `npm run dev`。

`.env.local` 已被 `.gitignore` 排除。不要在 browser code、source code、commit、console 或 log 放入 API key。

### 環境變數

| 變數 | 必須 | 預設 | 用途 |
|---|---:|---|---|
| `OPENAI_API_KEY` | Live Mode 必須 | 空白 | 只由 server route 讀取；空白時使用 Demo Mode |
| `OPENAI_MODEL` | 否 | `gpt-5.6-luna` | 集中設定 OpenAI multimodal model |
| `NUTRITION_API_KEY` | 否 | 空白 | 可選 USDA FoodData Central key；空白時只用本地 reference |
| `NEXT_PUBLIC_FIREBASE_API_KEY` | 帳戶／同步必須 | 空白 | Firebase Web API key |
| `NEXT_PUBLIC_FIREBASE_PROJECT_ID` | 帳戶／同步必須 | 空白 | Firebase project ID |
| `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN` | 帳戶／同步必須 | 空白 | Firebase Auth domain |
| `NEXT_PUBLIC_FIREBASE_APP_ID` | 帳戶／同步必須 | 空白 | Firebase Web App ID |
| `KCALCUE_ALLOWED_EMAILS` | API 必須 | 空白（拒絕存取） | 逗號分隔的試用 Email |
| `FIREBASE_ADMIN_CLIENT_EMAIL` / `FIREBASE_ADMIN_PRIVATE_KEY` | 無 ADC 的 hosting 必須 | 空白 | 只放在 server secret environment |

預設模型選擇原因記錄在 [DECISIONS.md](./DECISIONS.md)。OpenAI 官方資料：[GPT-5.6 Luna model page](https://developers.openai.com/api/docs/models/gpt-5.6-luna)、[structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs)、[images and vision](https://developers.openai.com/api/docs/guides/images-vision)。

## Architecture

```text
Browser image input
        │
        ▼
POST /api/analyze  (server-only, transient image bytes + container sniffing)
        │
        ▼
FoodVisionProvider
  ├── OpenAIFoodVisionProvider  ── image → structured estimate
  └── DemoFoodVisionProvider    ── deterministic demo estimate
        │
        ▼
Validated FoodAnalysis domain schema
        │
        ▼
Browser nutrition resolution
  └── LocalNutritionProvider (`NutritionProvider`)
        ├── canonicalizeFood
        ├── resolveNutritionMatch
        ├── locally resolved items ──────────────────────┐
        └── Live unresolved items                         │
                    │                                    │
                    ▼                                    │
             POST /api/nutrition/resolve                  │
                    │                                    │
                    ▼                                    │
       Optional server-side USDA fallback                 │
         └── UsdaNutritionClient (USDA FDC)               │
             conservative; gram-based results only        │
             are auto-included                            │
                    └────────────────────────────────────┘
                                                         │
                                                         ▼
                                      Deterministic calculation engine
        │
        ▼
Shared result UI + editing + immediate recalculation
```

主要邊界：

- `src/lib/providers/food-vision/`：只負責「圖片 → structured food analysis」。OpenAI SDK、prompt、timeout 及 API error mapping 不會滲入 UI。
- `src/lib/domain/`：provider-neutral schema、confidence、portion adjustment 及 unit transformation。
- `src/lib/nutrition/`：`NutritionProvider` interface、本地 browser reference adapter、server-side `UsdaNutritionClient` fallback 及 deterministic range calculation。
- `src/app/api/analyze/route.ts`：server-only input validation、provider selection、in-process rate limit 及 public-safe error codes。
- `src/components/`：一套共用 Demo/Live UI flow。
- `src/content/zh-HK.ts`：集中維護共用狀態及錯誤文案；元件專屬短文案留在相關元件。

未來新增本地模型或另一個 multimodal provider 時，只需實作 `FoodVisionProvider` 並在 factory 選擇；Result UI、meal domain model、nutrition service、confidence 及 calculation engine 不需要重寫。

## Nutrition data

AI 只辨認食物及估算份量，不提供正式 kcal／macro。Nutrition layer 會：

1. 把 `displayName` 轉成 canonical identity（與 UI 名稱分開）
2. 以 synonym／category／preparation 做 resolution，而不是只做 exact alias
3. 給每個 match 可信程度；low 或無法代表的組合菜式不計入總數
4. 用 **份量範圍 × 營養密度範圍** 做 deterministic calculation
5. 標示資料來源（KcalCue reference／USDA FDC）

本地 catalog 是可離線使用的 reference set，先由 browser 內的 `LocalNutritionProvider` resolve。Live 食物只有在本地無法可靠配對時，才會把 unresolved items 送到 `POST /api/nutrition/resolve`；該 server route 可按 `NUTRITION_API_KEY` 使用 `UsdaNutritionClient` 作可選 USDA FoodData Central fallback。USDA 結果保持保守：只有克（或有可靠 item-specific 克重換算）的結果會自動納入總數，其他單位維持 unresolved／不計入。沒有這把 key 時，App、Demo 與 partial result 仍然可用。

修改份量或 preset 只重算，不會再次呼叫 OpenAI 或 Nutrition API。

## Structured AI boundary

OpenAI Responses API request 使用：

- `input_image` + base64 data URL（raw base64 只在 server memory 建立，不會 log）
- `text.format.type: "json_schema"` + strict JSON Schema；Zod 仍是權威驗證
- `store: false`，不保存 Responses API response
- 90 秒 HTTP timeout，100 秒 abort guard
- OpenAI 支援 JPEG、PNG、WEBP 及非動畫 GIF；現有 HEIC／HEIF input 會先由 `sharp` 在 server memory 轉成 JPEG，不會寫入 disk

Server 收到回覆後仍會 `JSON.parse` 並再以 Zod schema 驗證。OpenAI strict schema 要求所有欄位 required，因此 domain optional fields 以 nullable schema 表示，收到後會移除 `null` 再驗證。

## 測試及驗證

```bash
npm run lint
npm run typecheck
npm test
npm run eval
npm run build
```

測試涵蓋 calculation ranges、所有 macros、g/ml/piece conversion、portion presets、confidence mapping、uncertainty de-duplication/fallback、schema validation、OpenAI error mapping、HEIC／HEIF conversion、API rate limit，以及 Demo analysis → nutrition → user correction → updated result integration pipeline。Component tests（jsdom）覆蓋 HEIC fallback、取消分析及 partial coverage 文案。

`npm run eval` 會獨立執行 representative food / meal cases，驗證 canonical identity、nutrition match、partial / unresolved coverage、composite dish safety、range ordering、非負值及 deterministic recalculation；不使用 OpenAI 或 USDA live API，也不建立精確 kcal golden numbers。

GitHub Actions workflow 位於 `.github/workflows/ci.yml`，只使用 `npm ci` 及 deterministic local checks，不需要 `OPENAI_API_KEY`、`NUTRITION_API_KEY` 或 production secrets。

V0.1 baseline 紀錄見 [GOAL_REPORT.md](./GOAL_REPORT.md)；HEIC／CI／evaluation readiness 見 [OVERNIGHT_REPORT.md](./OVERNIGHT_REPORT.md)（該 sprint 其後已經 PR `#1` 合併入 `main`）。

## Privacy design

- 使用 Firebase Authentication／Firestore；不使用 Firebase Storage，沒有 analytics。
- Demo Mode 不會將圖片傳到 server；可解碼相片會壓縮為本機草稿照片，Demo 結果不加入正式記錄。
- Live Mode 圖片以 multipart request 暫時傳到 KcalCue server，再以 data URL 傳給 OpenAI；HEIC／HEIF 會先在 memory 轉 JPEG。
- 只保存餐點及營養分析結果。圖片只在分析請求期間於 memory 處理，不寫入雲端、檔案或日誌；OpenAI Responses 使用 `store: false`。
- 本機草稿、記錄和待同步操作按帳戶分隔；草稿壓縮圖在儲存或放棄後清除。待同步修改須先處理才可登出，登出清除該帳戶本機資料。刪除後保留最小標記，阻止過期請求重建記錄。
- developer-safe timing diagnostics 只記錄 operation、MIME、byte size、計時及 resolved count，不記錄圖片、base64、食物名稱、prompt、個人資料或 secrets。
- 真正 Live Mode 使用時，圖片仍會由 OpenAI API 處理；部署者應同時審視其帳戶與資料處理條款。

## Public deploy checklist

正式公開前（hosting 由部署者設定；此 repo 不綁死單一平台）：

1. 只在 server env 放入 `OPENAI_API_KEY`／可選 `NUTRITION_API_KEY`，不要寫進 client 或 git。
2. 在 gateway／WAF 再加 rate limit。App 內 in-memory token bucket 只保護單一實例；serverless 多實例下會變弱。
3. 設定 Firebase Email Link／Google provider、授權網域、Admin 憑證及試用名單；在獨立專案部署 Firestore deny-all client rules，資料由 API 授權。
4. 用真實裝置手測：Live JPEG、HEIC（若裝置支援）、取消分析、429。

## Known limitations

- 香港／亞洲組合菜式 coverage 仍然有限。已有專屬保守 profile 的包括炒飯、炒麵、咖喱飯、燴飯、焗飯、餃子、叉燒／燒味飯、煲仔飯、雲吞麵／湯麵、粥、腸粉及港式奶茶。火鍋、車仔麵、壽司拼盤、沙律、果汁、pizza 及無名混合菜式在沒有可靠 profile 時維持 unresolved，而不是套用 generic rice／noodle／meat。
- USDA 即時查詢是可選的 server-side fallback，對港式食物名稱的命中率有限；沒有可靠克重換算的非克單位不會自動納入總數。
- OpenAI API 不直接接受 HEIC / HEIF；KcalCue 會在 server memory 以 `sharp` 轉成 JPEG。Safari 17 起由 WebKit 支援 HEIC 預覽，其他瀏覽器是否能直接顯示相片取決於其 image decoder；KcalCue 仍會在預覽失敗時保留分析入口。目標裝置的完整 browser matrix 仍需持續 QA。
- 單張相片本身無法知道真實重量、隱藏材料、油份、糖份或完整烹調方法；產品刻意以範圍及 uncertainty 表達。
- App 內 rate limit 是單實例記憶體 bucket，不是跨實例的 abuse-control 系統。
- 尚未在真正 KcalCue Firebase project、Email／Google OAuth、OpenAI key 或 iPhone／Android 實機完成驗收；自動化替身測試不代表這些項目已通過。
- 離線讀寫由持久 outbox 提供，應用開啟或恢復連線後自動同步；關閉 App 時不保證背景同步，AI 分析需要連線。
- 不提供醫療建議、個人減重目標、社交或付費功能。
