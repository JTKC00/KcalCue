# KcalCue Overnight Real-World Readiness Report

日期：2026-08-20 開始，2026-08-21（Asia/Hong_Kong）完成
分支：`feat/overnight-real-world-readiness`
基線：`main`，`30904adf9c3307ab4cf2acee29dc8e904b66925c`

## Scope and guardrails

本 sprint 以 pasted overnight brief 為工作合約，集中處理真實裝置圖片輸入、HEIC / HEIF、CI、nutrition reliability、deterministic evaluation、privacy 及 browser QA。

- 沒有 merge、deploy 或修改 production infrastructure。
- 沒有發出 Gemini、USDA 或其他 live external API request；所有 provider 行為以既有 mock / local adapter / route tests 驗證。
- 沒有讀取或輸出 `.env` secret；測試使用明確的 test-only placeholder，並驗證診斷 log 不會洩漏 key、token 或 base64。
- 沒有加入 image decoder、圖片 storage、analytics 或 database。

## Delivered

### HEIC / HEIF end-to-end path

- File picker 同時接受 `image/heic`、`image/heif` 及 `.heic`、`.heif`；保留既有 JPEG、PNG、WebP 支援。
- Client 由 MIME、檔名 extension 及實際內容處理瀏覽器 MIME 空白／不一致的情況。
- Server 不信任 `File.type`：在 10 MiB image limit 及 multipart `Content-Length` guard 後，以 JPEG、PNG、WebP signature 或 ISO-BMFF `ftyp` brand 偵測實際 MIME。
- Preview decoder 失敗時，UI 顯示「HEIC 相片已選擇」及「仍可進行分析」，不會因沒有 preview 而 disable analyze。
- Result sidebar 在 preview 失敗時繼續提供 fallback、移除及重新選擇操作。
- Gemini 官方文件列出 `image/heic` 及 `image/heif` inline image 支援：[Image understanding](https://ai.google.dev/gemini-api/docs/image-understanding)、[GenerateContent API](https://ai.google.dev/api/generate-content)。Safari / WebKit 的 HEIC 預覽能力依官方 release note 以 Safari 17 為基準：[WebKit Features in Safari 17.0](https://webkit.org/blog/14445/webkit-features-in-safari-17-0/)。

### Reliability and privacy

- `/api/analyze` 先以 multipart content length 擋住過大的 request，再以 image bytes 限制 10 MiB；不支援的 container 回傳 public-safe `invalid_file` / 415。
- `food-vision` 及 nutrition route 加入 privacy-safe latency diagnostics，只記錄 operation、mode/provider、MIME、byte size、duration 及 count，不記錄圖片、base64、食物名稱、prompt、個資或 secrets。
- Deterministic evaluation 暴露並修正兩個實際 catalog collision：`fried noodles` 被較短的 `noodles` 覆蓋，以及「混合菜式」被過寬的單字 alias 誤判為蔬菜；兩者均有 regression tests。

### Evaluation and CI

- `npm run eval` 新增 21 個 representative food / meal cases，覆蓋 canonical identity、exact / synonym / unresolved match、complete / partial / insufficient / none coverage、unit conversion、range ordering、非負值及 deterministic recalculation。
- Golden expectations 只驗證 identity、coverage 及 invariants，不宣稱精確 kcal 真值。
- `.github/workflows/ci.yml` 新增 GitHub Actions workflow：Node 20、`npm ci`、lint、typecheck、Vitest、eval 及 production build；只要求 `contents: read`，不讀取 provider secrets。
- README、DECISIONS、GOAL_REPORT historical pointer 及本報告已同步。

## Verification evidence

| Check | Result | Evidence |
|---|---|---|
| `npm run lint` | PASS | ESLint exit 0，無 errors / warnings |
| `npm run typecheck` | PASS | TypeScript `tsc --noEmit` exit 0；清理並重建 `.next` 後單獨重跑，無 generated-type collision |
| `npm test -- --reporter=verbose` | PASS | 12 test files，83 tests passed，0 failed |
| `npm run eval` | PASS | 21 cases；PASS 21、FAIL 0；canonical / nutrition / coverage / calculation 均 21/21 |
| `npm run build` | PASS | Next.js 16.3.0 production build；`/`、`/api/analyze`、`/api/nutrition/resolve`、`/manifest.webmanifest` 產出 |
| `git diff --check` | PASS | 無 whitespace errors |

Build 曾因本機同時產生 `.next/types` duplicate files 而出現一次 typecheck 噪音；停止 server、移除可重建的 `.next` 目錄後，依序執行 build 及 typecheck 均通過。`.next` 是 ignored build output，沒有納入 commit。

## Browser QA

測試方式：production build served at `http://127.0.0.1:3100`，以 real Chromium / Playwright CLI 操作；為避免外部費用及不可重現性，`/api/analyze` 使用 deterministic route mock。

### 375 × 812

- PASS：選取 PNG → analyze → result；顯示 kcal / macro range、food editor、uncertainty 及 sidebar。
- PASS：按份量「多」後由 `約 85–110 kcal` 更新至 `約 110–165 kcal`，沒有新增 `/api/analyze` request，證明修改在本地 deterministic recalculation。
- PASS：選入 `.heic` 後，preview fallback 顯示「HEIC 相片已選擇」及「仍可進行分析」，`開始分析` 維持 enabled。
- PASS：受控 HEIC flow 完成分析並進入結果頁；result sidebar 保留 HEIC fallback。
- PASS：`innerWidth=375`、`scrollWidth=375`、`bodyWidth=375`，無 horizontal overflow。

### 768 × 1024

- PASS：result layout 可讀，`innerWidth=768`、`scrollWidth=768`、`bodyWidth=768`，無 horizontal overflow。

### 1440 × 1000

- PASS：desktop result hierarchy 清楚；主內容約 1160px、context sidebar 320px。
- PASS：context sidebar 的 computed position 為 `sticky`。
- PASS：`innerWidth=1440`、`scrollWidth=1440`、`bodyWidth=1440`，無 horizontal overflow。
- PASS：視覺檢查確認 HEIC fallback card、kcal hero、macro cards、food details 及右側 context card 沒有重疊或裁切。

## Security and privacy review

- PASS：沒有新增 secret、credential、PEM、圖片落盤或 browser storage path。
- PASS：React UI 使用 text nodes；沒有新增 raw HTML sink、`eval`、`localStorage`、`sessionStorage`、IndexedDB 或 cache persistence。
- PASS：object URL lifecycle 仍會在更換／離開時 revoke；service worker 沒有 cache 個人圖片或 API response。
- PASS：route tests 覆蓋 provider error public mapping、secret redaction、HEIC MIME forwarding、invalid container 及 oversized multipart early rejection。
- 注意：public API route 的 authentication / rate limiting 仍屬 deployment boundary，repo 內沒有帳戶或 abuse-control layer；正式公開部署前必須由 hosting / gateway 補上。
- 注意：USDA optional fallback 現有 API key query-string integration 仍需由部署者按其 provider policy 評估；本 sprint 沒有擴大其 scope。

## Remaining limitations

- 本機沒有真實 HEIC fixture。byte-level tests 使用 synthetic ISO-BMFF `ftyp` headers 驗證 MIME routing；browser fallback QA 使用受控 `.heic` file 驗證 preview failure UX，不等同真實 codec decode。
- 不同瀏覽器／OS 的 HEIC decoder 支援不同；KcalCue 不為 preview 強制轉 JPEG，會保留原始 bytes 讓 provider 處理。目標裝置的完整 matrix 仍需由產品環境補測。
- 沒有 live Gemini credential request，因此 provider 真實服務可用性、帳戶 quota 及實際模型對 HEIC codec 的行為仍未在本機 end-to-end 證實；官方 request surface、schema、error mapping 及 MIME forwarding 已由文件與 tests 覆蓋。
- GitHub Actions workflow 已加入並以本機檢查對齊，但尚未 push，因此沒有 hosted runner 的實際 run ID。
- Local nutrition catalog 仍是有限的 MVP reference data；未知或組合菜式會維持 partial / unresolved，不會偽造精確營養值。

## Handoff

完成內容留在 `feat/overnight-real-world-readiness`，未 merge、未 deploy。下一個安全步驟是先 review 本報告及 `git diff`，再由 repository owner 決定是否 push 以觸發 CI；CI 成功標準是 workflow 中 lint、typecheck、tests、eval 及 build 全部綠燈。
