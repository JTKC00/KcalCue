# KcalCue V0.1 — Goal Report

完成日期：2026-08-13（Asia/Hong_Kong）

## Goal

從空白 workspace 自主設計、建立、測試及完成一個可實際執行的 KcalCue V0.1 Responsive Web App / PWA：讓使用者拍照／上載食物圖片，透過 provider-neutral AI food analysis layer 辨認可見食物及估算份量範圍，再由獨立 nutrition layer 及 deterministic calculation engine 計算 kcal / Protein / Carbs / Fat 範圍；誠實呈現 confidence 及 uncertainty，並讓使用者即時修正。

使用者後續指令將首個 Live AI Provider 由原始 OpenAI 要求取代為 Google Gemini API，環境變數改為 `GEMINI_API_KEY` / `GEMINI_MODEL`；V0.1 不需要 OpenAI provider。

## What was built

- 完整香港繁體中文 homepage、產品理念、主 CTA、privacy 及 Demo Mode banner。
- 手機 camera input、裝置 file picker、JPEG/PNG/WebP preview、replace、remove、10MB limit、invalid/oversized/read-failure states。
- Server-only `/api/analyze` endpoint；API key 不會傳到 browser。
- `FoodVisionProvider` interface、`GeminiFoodVisionProvider`、`DemoFoodVisionProvider` 及 environment-based factory。
- Google Gen AI SDK image request、JSON Schema structured output、Zod second validation、timeout/retry 及 public-safe error mapping。
- `FoodAnalysis` domain schema：food identity、portion min/max、unit、recognition/portion confidence、visible/estimated/unknown information 及 uncertainty reasons。
- Independent `NutritionProvider` interface、明確標示為 demo/reference 的本地 nutrition adapter、unit conversion 及 partial-coverage handling。
- Deterministic meal engine：calories、protein、carbs、fat min/max；沒有讓 LLM 心算營養結果。
- Result hierarchy：kcal range、midpoint、macro ranges、overall confidence、food breakdown、uncertainty/explainability。
- Editable food name、少/普通/多 presets、advanced g/ml/件/碗/杯、manual min/max、add、delete 及 immediate recalculation。
- Initial、image selected、analysing、success、partial、unable-to-identify、invalid file、API/network/timeout/invalid response、retry、manual entry 及 Demo fallback states。
- 375px mobile、768px tablet、1440px desktop responsive layouts；visible keyboard focus、semantic headings/regions/forms、labels、ARIA loading/error states及 reduced motion。
- PWA manifest、SVG icon、standalone metadata 及不 cache 私人資料的 minimal service worker。
- README、environment example、architecture decisions、45 automated tests及本報告。

## Architecture

```text
Image input
  → POST /api/analyze (server-only)
  → FoodVisionProvider
      → GeminiFoodVisionProvider (Live)
      → DemoFoodVisionProvider (no key / explicit fallback)
  → Zod-validated FoodAnalysis
  → NutritionService + NutritionProvider
  → deterministic range calculation
  → shared Result/Edit UI
```

Framework-specific code只處理 routing及 UI；domain、provider contract、nutrition及 calculation 都是獨立 TypeScript modules。Provider details 不會流入 Result UI，nutrition data 不由 AI 當作唯一 truth source。

完整說明見 [README.md](./README.md)，主要產品／技術取捨見 [DECISIONS.md](./DECISIONS.md)。

## Verification

### Automated validation — final clean run

| Command | Result | Evidence |
|---|---|---|
| `npm run lint` | PASS | ESLint 9 + Next core-web-vitals/typescript config，exit 0，0 errors/warnings |
| `npm run typecheck` | PASS | TypeScript 6.0.3 `tsc --noEmit`，exit 0 |
| `npm test -- --reporter=verbose` | PASS | Vitest：4 test files，45 tests passed，0 failed |
| `npm run build` | PASS | Next.js 16.3.0 production build compiled、TypeScript checked、4 pages generated；`/`、`/api/analyze`、`/manifest.webmanifest` 產出成功 |

Test coverage includes：

- kcal 及所有 macro min/max calculation
- g、ml、piece conversions及無 conversion handling
- portion presets及 baseline behavior
- confidence thresholds及 conservative meal confidence
- uncertainty de-duplication及 fallback
- valid/invalid structured AI response
- Gemini empty/malformed/schema-invalid response
- Gemini HTTP 400/401/403/404/413/415/429/500/503/504、client timeout及 unknown errors
- Gemini request model、inline image及 JSON Schema config
- Demo input → food analysis → nutrition → user correction → updated kcal/macros integration pipeline

### Production runtime / API smoke test

- `next start -p 3100 -H 127.0.0.1`：PASS，production server Ready。
- `POST /api/analyze` with `mode=demo`：HTTP 200；`mode=demo`、`analysisStatus=success`、4 foods，首項含所有 required schema fields。
- `/manifest.webmanifest`：HTTP 200、`application/manifest+json`、standalone metadata及 any/maskable icons。
- Runtime headers：`X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: strict-origin-when-cross-origin`、camera-only `Permissions-Policy`。
- No-key runtime 明確顯示 Demo Mode，沒有假裝分析上載圖片。

### Manual browser QA

使用 real Chromium via Playwright CLI 對 production server 操作：

#### Mobile — 375 × 812

- PASS：homepage、CTA、Demo banner、相片 chooser、PNG preview、replace/remove controls。
- PASS：loading state有 `aria-busy`、清楚 progress copy及可見 scan treatment。
- PASS：result 首屏首先顯示 `約 565–765 kcal`、macro ranges及低可信粗略估算提醒。
- PASS：按白飯「多」後，不呼叫 AI 即由 `565–765` 更新至 `615–895 kcal`；Protein/Carbs 同步更新。
- PASS：選入 `.txt` 後顯示「呢個檔案唔支援」，input flow仍可繼續使用。
- PASS：`innerWidth=375`、document `scrollWidth=375`；無 horizontal overflow。
- PASS：browser console 0 errors、0 warnings。
- 修正並 re-test：首次 QA 發現 stage transition 保留舊 scroll position；加入 stage-based scroll reset 後結果 state `scrollY=0`。
- 最終 production re-test：accessibility snapshot只出現2個可見上載按鈕；2個原生 file inputs為真正 hidden，沒有重複 keyboard controls。Demo request body只有 `mode=demo`，不含所選圖片。

#### Tablet — 768 × 1024

- PASS：result header、三個 macros、confidence及editing card responsive layout。
- PASS：`innerWidth=768`、document `scrollWidth=768`；無 horizontal overflow。

#### Desktop — 1440 × 1000

- PASS：homepage 使用真正兩欄 hero/upload composition，不是單純拉闊 mobile UI。
- PASS：result 使用主內容 + sticky context sidebar、三欄 macros及清楚 hierarchy。
- PASS：相片 input → Demo analysis → result flow。
- PASS：「新增食物」由4項變5項並進入 partial state；「刪除未命名食物」後回復4項。
- PASS：`innerWidth=1440`、document `scrollWidth=1440`；無 horizontal overflow。
- PASS：browser console 0 errors、0 warnings。
- 最終 production re-test：result grid為 `814px 320px` 兩欄，context sidebar保持 `position: sticky`。

QA screenshots 保留於 ignored local `output/playwright/`：mobile homepage/preview/loading/result、desktop homepage/result、tablet result，以及最終 `final-mobile-result.png` / `final-desktop-result.png`。

### Security / privacy checks

- PASS：沒有 `.env`、`.env.local`、PEM或key files。
- PASS：secret-pattern scan只命中 README 的 `your-server-side-key` 說明 placeholder，沒有 credential-like value。
- PASS：沒有 `console.log/debug/info`、base64 data URL dump、TODO/FIXME/XXX。
- PASS：Demo Mode圖片不送往 API；Live Mode server只以 memory bytes處理，不寫檔、不進 database/storage/history。
- PASS：`.env.example` 只有空 `GEMINI_API_KEY=` 及 non-secret model name。

## Definition of Done

| Requirement | Status | Evidence |
|---|---|---|
| Application 可以在本機正常啟動 | PASS | Production server Ready + real browser QA |
| 首頁完整 | PASS | Mobile/desktop screenshots及 accessibility snapshot |
| 支援圖片選擇／拍照入口 | PASS | camera capture input + library picker，browser exercised picker |
| 有清晰圖片 preview flow | PASS | preview/replace/remove，mobile exercised |
| Gemini image-analysis provider architecture 已建立 | PASS | provider interface + Gemini/Demo implementations + factory；addendum取代原 OpenAI要求 |
| API secret 只存在 server-side | PASS | env read及Gemini SDK只在 server provider/API route dependency graph |
| 沒有 API key 時有完整 Demo Mode | PASS | no-key production runtime + API/UI flow exercised |
| Demo Mode 不會假裝真正分析使用者照片 | PASS | persistent banner/result note；Demo request不包含 image |
| Food analysis 使用 structured validated data | PASS | JSON Schema + Zod second validation + tests |
| Nutrition layer 與 AI layer 分離 | PASS | independent interfaces/services/modules |
| Calculation engine 為 deterministic code | PASS | pure TypeScript functions + unit/integration tests |
| kcal 使用 range 表達 | PASS | primary result及food rows均顯示 min–max |
| Protein / Carbs / Fat 使用合理 range | PASS | calculated macro cards + tests |
| 有 High / Medium / Low confidence | PASS | threshold mapping及HK copy |
| 顯示 uncertainty reasons | PASS | meal/food reason list + explainability details |
| 使用者可以修改食物 | PASS | editable labelled name fields + local lookup |
| 使用者可以修改份量 | PASS | presets、min/max及unit controls；browser exercised |
| 使用者可以新增／刪除 food items | PASS | browser exercised 4→5→4 items |
| 修改後結果會即時重新計算 | PASS | browser exercised 565–765→615–895 + integration test |
| 無法辨認食物時不會硬估 | PASS | schema invariant + unable UI/manual/replace/retry flow |
| 有 loading / empty / error / retry states | PASS | implemented states；loading/invalid-file browser exercised |
| UI responsive | PASS | 375/768/1440 visual QA，scrollWidth matches viewport |
| 基本 accessibility 完成 | PASS | semantic snapshots、labels、focus、ARIA、contrast/reduced motion |
| 圖片不會被不必要持久保存 | PASS | no storage/database/write path；object URL lifecycle |
| 沒有 secret 被寫入 repo | PASS | secret/env scan |
| automated tests 通過 | PASS | 45/45 |
| typecheck 通過 | PASS | final `tsc --noEmit` exit 0 |
| lint 通過 | PASS | final ESLint exit 0 |
| production build 成功 | PASS | final Next production build exit 0 |
| README.md 完成 | PASS | setup、stack、Demo、Gemini、env、testing、architecture、privacy、limitations |
| DECISIONS.md 完成 | PASS | 11 major autonomous decisions |
| GOAL_REPORT.md 完成 | PASS | 本報告 |

結論：Definition of Done 全部 PASS。

## Remaining limitations

- 沒有提供 Gemini credential，因此未對真實 Gemini endpoint發出付費 image request。官方 SDK surface已查證；production request shape、structured validation及failure mapping以 mock tests驗證。
- 本地 nutrition provider是有限的 MVP demo/reference catalog，不是即時官方資料。未配對項目會清楚標示 partial/none，而不是偽造營養值。
- 圖片估算固有地不知道真實重量、隱藏食材、油、糖、醬汁配方及被遮蓋部分；這正是 UI 採用 range + uncertainty 的原因。
- V0.1 沒有帳戶、history、database、analytics、social、付費或醫療功能，屬刻意 scope boundary。

## Autonomous decisions

主要決定包括 Next.js單體架構、provider-neutral domain boundary、Gemini 3.5 Flash-Lite預設、Zod second validation、local nutrition adapter、deterministic conservative ranges、single Demo/Live UI、10MB JPEG/PNG/WebP boundary、calm HK design system、privacy-minimal PWA及lint-compatible toolchain。完整理由見 [DECISIONS.md](./DECISIONS.md)。
