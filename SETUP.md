# KcalCue Firebase 設定

## 專案與費用

建議建立獨立的 KcalCue Firebase 專案，並在需要 Blaze 時連到現有的 Cloud Billing 帳戶。Blaze 是按專案啟用的用量計費方案，另一個專案已有 Blaze 不會自動替新專案啟用。本次改動沒有建立或修改任何雲端專案。

KcalCue 使用 Firebase Authentication 與 Cloud Firestore（Standard / Native mode）。**不需要建立 Firebase Storage bucket；不會上傳或保存食物圖片到 Storage。** 離線能力由應用程式的本機佇列提供，不依賴 Blaze。Firebase 用量、Email 寄信額度及 hosting 費用仍依實際方案計算。

若選擇共用其他 App 的 Firebase 專案，Authentication 使用者與專案設定也會共用；不能直接覆蓋該專案的 rules。本 repo 的 rules 以獨立 KcalCue 專案為部署目標。

參考：[Firebase 計費](https://firebase.google.com/docs/projects/billing/firebase-pricing-plans)、[價格與免費額度](https://firebase.google.com/pricing)。

## Firebase Console

1. 註冊 Web App，取得 apiKey、authDomain、projectId 和 appId。
2. 建立 Firestore Standard / Native mode 資料庫，按試用者與 hosting 所在位置選擇區域。不要啟用測試模式的公開讀寫規則。
3. Authentication → Sign-in method：啟用 Email/Password 及其 Email link 選項，同時啟用 Google provider 並設定支援 Email。
4. 在 Authorized domains 加入正式 HTTPS 網域。開發時另外加入 localhost 或實際開發 host；不要把測試網域當成正式環境。
5. 設定 Email 寄件名稱、範本及 Google 同意畫面的 App 品牌。
6. 為獨立專案部署 `firestore.rules`：

```sh
npx firebase-tools@15.29.0 deploy --only firestore:rules --project YOUR_KCALCUE_PROJECT_ID
```

Rules 拒絕所有 Web SDK 直接讀寫。資料存取經 Next.js API：Firebase Admin 驗證 ID token、撤銷狀態、Email 驗證狀態與試用名單，再只使用 token 的 UID 存取 `kcalcueUsers/{uid}/meals/{mealId}`。客戶端傳入的 userId 不決定資料擁有人。Admin SDK 不受 rules 限制，因此 API 授權不可移除。

資料儲存時自動建立，沒有 SQL migration。不需要建立 Storage、Cloud Functions 或 Firebase Hosting 才能使用這份程式。

## 環境變數與 hosting

複製 `.env.example` 為 `.env.local`，填入：

```dotenv
NEXT_PUBLIC_FIREBASE_API_KEY=YOUR_WEB_API_KEY
NEXT_PUBLIC_FIREBASE_PROJECT_ID=YOUR_KCALCUE_PROJECT_ID
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=YOUR_KCALCUE_PROJECT_ID.firebaseapp.com
NEXT_PUBLIC_FIREBASE_APP_ID=YOUR_WEB_APP_ID
KCALCUE_ALLOWED_EMAILS=tester1@example.com,tester2@example.com
OPENAI_API_KEY=YOUR_SERVER_ONLY_KEY
OPENAI_MODEL=gpt-5.6-luna
NUTRITION_API_KEY=
```

Web App 的四個公開設定可以出現在瀏覽器。試用名單由 server 判斷，空白時拒絕 API 存取；成功登入不代表自動取得试用權限。Email Link 與 Google 帳戶均需通過相同檢查。

Firebase Admin 需要伺服器憑證：Google Cloud hosting 優先使用 Application Default Credentials；其他 hosting 可使用專用 service account，將 `FIREBASE_ADMIN_CLIENT_EMAIL` 與 `FIREBASE_ADMIN_PRIVATE_KEY` 放入伺服器 secret environment variables。Private key 可包含實際換行或 `\n`。服務帳戶需要 Firestore 資料存取及讀取 Firebase Auth 使用者的權限；不需要 Storage 權限。不要將 service account JSON、private key 或 OpenAI key 放進 `NEXT_PUBLIC_`、git 或聊天。

沿用可執行 Next.js Node runtime、sharp 和 AI 請求的 HTTPS hosting。修改公開環境變數後重新 build；CSP 會允許指定 authDomain 與 Firebase Auth 所需的 Google origins。

## 登入行為

- Email：寄出登入連結，在同一裝置開啟。跨裝置或沒有本機 Email 記錄時，畫面要求再次輸入收信的 Email，不會從 URL 推斷 Email。登入完成後移除 callback query。
- Google：使用 Firebase Google OAuth popup，讓使用者選擇帳戶。若瀏覽器攔截 popup，可允許後重試或使用 Email 連結。
- Email 連結可能在一般瀏覽器開啟，而非已安裝 PWA；兩者是否共用網站儲存由平台決定。草稿保留在原來的瀏覽器／PWA，不能保證自動跨容器搬移。
- 首次登入需要連線。已登入的装置可離線讀写。重新登入同一帳戶後自動重試待同步操作。
- 登出前須完成同步或處理衝突，避免清除未上傳修改。登出會清除該帳戶的本機草稿和餐點快取；其他帳戶的資料不會顯示於目前帳戶。

參考：[Email Link](https://firebase.google.com/docs/auth/web/email-link-auth)、[Google 登入](https://firebase.google.com/docs/auth/web/google-signin)。

## 離線與同步設計

App 使用帳戶分隔的 IndexedDB 保存草稿、雲端快照與待同步操作。新增、修改及刪除先完成本機持久寫入，立即更新畫面；寫入完成不等於雲端已確認，畫面會列出待同步數量。

應用開啟、恢復連線、返回前景及前景期間會嘗試同步：有待同步操作時每 5 秒重試，沒有操作時每 30 秒檢查版本。**關閉瀏覽器／PWA 後不保證背景上傳；下次開啟會繼續。** API 先檢查一份帳戶版本文件，無變更時不重新查詢整份餐點歷史；資料變更時才讀取最新記錄。

本實作刻意使用應用層 outbox 和 server Firestore transactions，並非直接使用 Firestore Web SDK 的 last-write-wins 離線寫入：這樣能保留伺服器營養重算、Email 試用名單、刪除標記和明確的版本衝突。請勿改成瀏覽器直接寫資料而繞過驗證。

每個操作保留固定 mutation ID；重試不會重複新增。多分頁以 Web Locks 排序同步，同一份本機資料的讀改寫使用單一 IndexedDB transaction。需要支援 IndexedDB 與 Web Locks 的現代瀏覽器。

若另一裝置已修改同一餐，伺服器拒絕舊版本，佇列保留本機修改，停止該餐的後續操作；其他餐仍可同步。使用者可保留修改為新餐點草稿，或放棄待同步修改並使用雲端版本。刪除只在雲端留下 ID、版本與 mutation ID 等最小標記，餐點內容會移除，阻止過期請求復活資料。

離線只保證已下載記錄可讀，AI 分析仍需要連線。首次使用 PWA 必須先連線載入。瀏覽器可能因空間壓力或使用者清理網站資料而刪除本機資料；尚未同步的修改只存在該裝置。

## 圖片處理與資料最小化

食物圖片以 multipart 傳至 backend，在記憶體處理並送到 OpenAI 分析；KcalCue 不將原圖、壓縮圖、base64 或 image payload 寫入 Firestore、Storage、檔案或應用程式日誌。OpenAI Responses 請求保留 `store: false`；供應商資料處理仍依 OpenAI 帳戶政策。

本機尚未儲存的草稿可暫存壓縮圖片，方便關閉後繼續；正式儲存或放棄草稿後清除。儲存 API 只接受餐點 metadata 和營養分析欄位，photoPath 不能指向任何圖片；同步佇列不包含 Blob。已儲存記錄不顯示照片縮圖，也不能用原圖重新分析，需要重新選圖。

## 驗證

```sh
npm ci
npm run lint
npm run typecheck
npm test
npm run eval
npm run build
npm run test:e2e
```

E2E 使用合成 Firebase Web config、Firebase Auth/API 網絡替身，以及真正 browser IndexedDB、Web Locks、service worker；不寄 Email，不開真實 Google OAuth 或呼叫 OpenAI。E2E 會以測試公開設定重新 build，完成後執行正常 `npm run build` 才可部署。

Firestore 交易與 rules 使用官方模擬器（需要 Java 21）：

```sh
npx firebase-tools@15.29.0 emulators:exec --only firestore --project demo-kcalcue "npm run test:firestore"
```

模擬器測試只接受本機 `FIRESTORE_EMULATOR_HOST`，固定使用 demo project，拒絕連到真實專案。CI 也會執行。真實登入、hosting 設定及 iPhone／Android 的待驗收項目見 `ACCEPTANCE.md`。
