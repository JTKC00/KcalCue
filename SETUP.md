# KcalCue 帳戶與記錄設定

## 1. 建立獨立 Supabase 專案

在自己的 Supabase organization 建立 `KcalCue`。香港試用者可優先考慮 Singapore 區域；建立前檢查帳戶方案與專案費用。本次程式實作沒有建立付費資源，也沒有改動 DevRoom AI 或 ECHOES Playtest。

在新專案 SQL Editor 執行 `supabase/migrations/20260909025204_meal_journal.sql`，或使用 Supabase CLI 的 migration 部署流程。Migration 包括：

- `meals`：餐點、server 計算的營養摘要、版本號、日期與資料快照。
- `meal_photos`：私人照片及待完成上傳的追蹤資料。
- `meal-photos` 私人 bucket：只允許 JPEG，最大 5 MiB。
- 每張表的 RLS、明確權限及擁有人／日期索引；Storage 只能讀寫自己的路徑。

Migration 不應套到其他產品的既有資料庫。請保留 SQL migration 作為環境版本紀錄；不要把生產 database password 放在 shell history。

## 2. 環境變數

複製 `.env.example` 為 `.env.local`，填入：

```dotenv
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=YOUR_PUBLISHABLE_KEY
OPENAI_API_KEY=YOUR_SERVER_ONLY_KEY
OPENAI_MODEL=gpt-5.6-luna
NUTRITION_API_KEY=
```

Supabase URL 和 publishable key 可出現在 browser；資料隔離依靠 RLS。**不要使用 service_role／secret key 代替 publishable key，也不要加上 `NEXT_PUBLIC_` 暴露 OpenAI key。** 目前實作不需要 Supabase service_role key。

修改公開環境變數後必須重新 build；CSP 只允許這個 Supabase origin。部署時把相同變數放在 hosting 的環境設定，`.env.local` 不提交 git。

沒有 Supabase 設定時，App 顯示無法同步，仍可用 Demo、手動編輯和本機草稿；Live 圖片分析必須有已驗證帳戶。没有 OpenAI key 時只回傳明確標示的示範結果，Demo 不加入正式記錄。

## 3. Email 驗證碼與試用帳戶

1. 在 Auth 設定關閉公開註冊，只由管理員預建試用帳戶並確認 Email。
2. 設定自己的 SMTP 寄信服務、寄件網域與寄件地址。新 Free 專案使用預設 SMTP 時可能無法修改 Email template，因此 OTP 試用應配置自訂 SMTP。
3. Email 的 Magic Link template 改為顯示 `{{ .Token }}`，例如「KcalCue 驗證碼：{{ .Token }}」。這裡使用輸入驗證碼登入，不需要點擊郵件連結返回 PWA。
4. 設定正式 HTTPS Site URL、開發與試用站的合法 redirect URLs；使用短效 OTP 和寄信限流。UI 重寄倒數為 60 秒，server 設定應一致。
5. 用兩個真正試用帳戶確認寄信、錯誤／過期 OTP、登入保持、重新登入及資料隔離。

參考：[Email OTP](https://supabase.com/docs/guides/auth/auth-email-passwordless)、[Supabase changelog](https://supabase.com/changelog)、[私人 Storage](https://supabase.com/docs/guides/storage/buckets/fundamentals)。

## 4. 儲存與離線行為

App 使用 browser Supabase Auth session，API 每次用 bearer token 向 Auth 驗證使用者，再以該使用者的權限存取資料；首頁 HTML 不包含個人資料。所有 API 回應不進入 service worker 快取。

草稿和已同步記錄使用帳戶分隔的 IndexedDB。可預覽的圖片先在 browser 壓縮成 JPEG；Live HEIC／HEIF 無法解碼時使用已登入的 server 轉換。儲存照片前 server 再檢查檔案、校正方向、縮到最長邊 1600px 並去除 EXIF。Demo 不上傳原圖。

離線不自動提交新增／修改／刪除；重新連線或重新登入後，由使用者再次確認儲存。記錄保留原來的日期與 IANA 時區，不會因旅行而搬到另一天。日總數是已計入食物的範圍之和；資料不足時明示部分估算或未知。

修改使用版本比較；同一草稿重試保留 mutation ID，避免重複新增。衝突保留本機草稿，使用者可載入最新記錄再修改。刪除後清除餐點內容，只保留 ID、擁有人、版本等刪除標記，防止舊請求把資料復活。

照片清理失敗會提示重試。清除全部記錄也會檢查未連到記錄的照片，包括失敗上傳。不要手動刪除 `meal_photos` rows 代替 Storage API 刪除，否則會留下無法追蹤的檔案。

PWA 需要首次連線載入才能離線啟動。離線只保證已下載的記錄與照片可讀；瀏覽器仍可能因裝置空間不足而清除本機快取，雲端已儲存記錄不受影響。

## 5. 檢查與試用發布

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run eval
npm run build
npm start
```

`npm run test:e2e` 使用測試专用公開設定重新 build，啟動 3100 port，以模擬 Auth／meal API 及瀏覽器真實 IndexedDB／service worker 驗證流程，不會使用真正 API keys。Windows 使用已安裝的 Edge；Linux／CI 先執行 `npx playwright install --with-deps chromium`。測試後需執行正常 `npm run build`，才可部署。

測試碼不建立真正雲端帳戶。`npm test` 中的 PGlite 會執行實際 PostgreSQL migration 與 RLS，但 Auth／Storage 平台表是測試替身；正式 Supabase 套用後仍須跑 Security Advisor 並以兩個帳戶驗收。

使用能執行 Next.js Node runtime、sharp 和長時間 AI 請求的 HTTPS hosting。保留目前 API 請求限流；本輪只提供小範圍試用，正式公開流量仍需要額外的跨實例 gateway 限流。

實機驗收項目與尚未完成的外部設定見 `ACCEPTANCE.md`。
