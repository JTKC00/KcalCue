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

原始 V0.1 baseline 曾把 HEIC / HEIF 留作 product gap；本文件第 17 節記錄 overnight readiness sprint 的取代決定。

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

---

## 17. HEIC / HEIF 原始 bytes 與 preview fallback（2026-08-20）

查閱 Google 官方 [Gemini image understanding](https://ai.google.dev/gemini-api/docs/image-understanding) 及 [GenerateContent API](https://ai.google.dev/api/generate-content) 文件後，Gemini inline image 支援 `image/heic` 及 `image/heif`，因此不加入 decoder 或先轉 JPEG 的 dependency。原始檔案只會短暫存在 browser object URL、request memory 及 Gemini inline base64 中。

Safari / WebKit 的官方 [Safari 17 release note](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/) 確認 Safari 17 起支援 HEIC image；其他瀏覽器是否可直接預覽取決於其 decoder。Preview failure 不再阻止分析：UI 顯示「HEIC 相片已選擇」及 fallback 說明，仍保留分析、更換、移除操作。

Server 不信任 `File.type`：在 10 MiB image limit 及 multipart `Content-Length` guard 後，以 JPEG、PNG、WebP magic bytes 或 HEIF/HEIC ISO-BMFF `ftyp` brands 判斷實際 MIME，再將該 MIME 傳給 provider。這同時處理 MIME 空白／不一致及基本 MIME spoofing，而不把私人圖片寫入 disk。

本地沒有真實 HEIC fixture，亦沒有 credential 可作 live Gemini image request；raw HEIC forwarding 以 header-detection、route mock 及 preview fallback tests 驗證，真實 target-browser matrix 保留為 limitation。

## 18. CI boundary（2026-08-20）

`.github/workflows/ci.yml` 使用 GitHub 官方 `actions/checkout@v6` 及 `actions/setup-node@v6`、Node 24、npm cache、`npm ci`，並設 `permissions: contents: read`。Node.js 支援範圍以 `package.json` `engines` 為準：`^22.22.2`、`^24.15.0` 或 `>=26.0.0`；CI 固定使用其中的 Node 24。CI 只執行 lint、typecheck、Vitest、`npm run eval` 及 production build，不讀取 Gemini、USDA 或 production secrets。

## 19. Deterministic evaluation contract（2026-08-20）

`npm run eval` 使用 representative food / meal cases，驗證 canonical identity、match type、included / unresolved、complete / partial / insufficient / none coverage、unit conversion、range ordering、非負值及相同輸入的 deterministic recalculation。Golden expectations 不包含聲稱真實的精確 kcal 數字。 Composite dish cases 驗證不得把 risotto／炒飯／意粉等配成單一 rice／noodle／bread／meat profile 並計入總數。

## 20. Privacy-safe latency diagnostics（2026-08-20）

只記錄 operation、mode/provider、image MIME、byte size、`foodVisionMs`、`nutritionResolveMs`、`totalMs` 及 resolved count；不記錄圖片、base64、食物名稱、prompt、個人識別資料或 secrets。分析及 nutrition route 的 timing log 使用既有 developer-safe `console.error` channel，沒有第三方 analytics。

## 21. Evidence-backed canonical collision fixes（2026-08-20）

Deterministic evaluation 發現兩個實際 collision：英文 `fried noodles` 被較短 `noodles` identity 覆蓋，以及「混合菜式」被單字 alias「菜」誤判為蔬菜。加入 fried-noodles 同義詞並移除過寬單字 alias；新增 regression tests，保持 composite / unresolved 不會套用 generic nutrition profile。

## 22. Composite dish safety（2026-08-24）

真實 Live case「墨魚汁意大利飯」曾被 Canonical Identity 因短詞「飯」判成 `rice`，再 High-confidence fallback 到 USDA 白米飯（熟）。這違反「精準呈現不確定性，而不是假裝精準」。

Invariant：若 Canonical Identity 表示 composite dish，而 Nutrition Catalog 沒有該菜式本身的可靠 profile，Resolver 不得 fallback 到其中單一基礎食材，亦不得把結果視為可計算的 High / Medium match。

Precedence 不再靠 array ordering：`named_dish` > `dish_class` > `specific_food` > `generic_ingredient`，同層再比 matched key 長度。Cross-family 組合（starch + protein / sauce）及 rice leftover 分析會把「蘑菇飯」「牛肉麵」提升為 dish，但「白飯」「紅米飯」「steamed rice」仍是 simple rice。

Compatibility：`dish → dish` 與 `ingredient → ingredient` 才可計入；`dish → ingredient` 一律 unresolved，文案說明找到相近基礎食材但不足以代表整道菜。USDA live fallback 對 composite identity 不查詢。不為每道餐廳菜加 alias，也不把所有含「飯」的名稱都當 unresolved。

## 23. In-process public API rate limit（2026-09-08）

`/api/analyze` 每 IP 每分鐘 5 次，`/api/nutrition/resolve` 每 IP 每分鐘 20 次，使用記憶體 token bucket。IP 取 `x-forwarded-for` 最左值。這是公開部署前的最小 abuse 防護，不是帳戶系統，也不是跨 serverless 實例的全域限流；正式公開時仍應由 gateway 再限一次。

## 24. Live 分析可取消，不縮短 Gemini timeout（2026-09-08）

保留 90 秒 HTTP timeout。Client 用 `AbortController` 對齊該上限，並提供取消。Loading 步驟只隨等待時間推進，不宣稱 server 已完成該步。取消不當成 `unknown` error。

## 25. 有界港式 catalog 擴充（2026-09-08）

新增有來源、寬範圍的 composite profile：叉燒／燒味飯、煲仔飯、雲吞麵／湯麵、粥、腸粉、港式奶茶。火鍋、果汁、pizza 等維持 unresolved。港式奶茶不得套用全脂奶 profile。

## 26. PWA PNG icons（2026-09-08）

iOS 主畫面需要 PNG `apple-touch-icon`。保留 SVG，另提供 192／512 PNG。Service worker 仍不 cache 相片或 API response。

## 27. CSP 與現有 preview 共存（2026-09-08）

加入 `Content-Security-Policy`：`img-src` 允許 `'self' blob: data:`，以支援本機 object URL preview。`script-src` 暫時包含 `'unsafe-inline'`，以便與 Next.js App Router hydration 共存，而不引入 nonce middleware。

## 28. OpenAI food-vision provider migration（2026-09-03）

目前 Live provider 由 Gemini 改為 OpenAI Responses API；`FoodVisionProvider`、domain model、nutrition layer、calculation engine 及 UI contract 保持不變。`OpenAIFoodVisionProvider` 集中擁有 OpenAI SDK、model config、prompt、strict structured output、timeout、image preparation 及 error translation；API key 只由 server-side `OPENAI_API_KEY` 讀取，沒有 key 時仍由 factory 選 Demo provider。

預設 model 選用 `gpt-5.6-luna`，原因是官方 model guide 將它定位為 cost-sensitive、high-volume workload，並確認支援 image input 及 Structured Outputs；可由 `OPENAI_MODEL` 覆寫。Responses API 使用 `input_image` data URL、`text.format` 的 `json_schema` strict mode 及 `store: false`，回覆仍要經 JSON parse 及 Zod second validation。

OpenAI image input 官方支援 PNG、JPEG、WEBP 及非動畫 GIF，不包括現有產品允許的 HEIC／HEIF。為保留既有上載及 preview fallback contract，HEIC／HEIF 只在 server memory 以 `sharp` 轉 JPEG 後送出；轉換失敗回傳 public-safe `image_rejected`，不會把圖片寫入 disk。此前 Gemini-specific provider details 保留作歷史紀錄，以上決定為目前 runtime 行為。

整合補充（2026-09-08）：OpenAI provider 接受 request AbortSignal，與原有 100 秒 abort timeout 合併；client 與 SDK HTTP timeout 維持 90 秒。
