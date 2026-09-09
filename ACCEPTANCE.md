# Firebase 核心流程驗收

本文件只將實際執行的檢查標示為通過。Firebase 真實帳戶與手機驗收和本機測試分開記錄。

## 本機驗證（2026-09-09）

- [x] 215 個單元／整合測試通過，包含 Firebase 登入 SDK 接線、token 授權、試用名單、IndexedDB outbox、斷線重試、帳戶切換及多分頁同步。
- [x] 47 個 deterministic nutrition evaluation 案例通過，不呼叫真實 OpenAI／USDA。
- [x] 官方 Firestore 模擬器 8 個測試通過：營養重算、重試去重、同步交易競爭、原始快照保留、UID 隔離、刪除標記、直接 client rules 拒絕及無變更時只回傳版本。
- [x] 5 個 Edge 端到端測試通過：Email Link 替身登入與草稿搬移、自動重試、離線新增／修改／刪除及重開恢復、重連同步、雙裝置衝突恢復、PWA 離線殼、圖片不被上傳保存。
- [x] TypeScript、ESLint、正常設定的 production build 通過。
- [x] npm audit：0 vulnerabilities。

E2E 使用合成 Firebase 設定與 Auth／meal API 網絡替身；瀏覽器的 IndexedDB、Web Locks 和 service worker 為實際執行。Firestore 模擬器執行真正交易和規則，但不代表雲端設定已完成。Google OAuth 的 SDK 呼叫及選擇帳戶設定有單元測試，真正 OAuth 授權尚待以下驗收。

## 真實 Firebase 試用环境

- [ ] 確定 KcalCue Firebase project ID；建議獨立專案，需要 Blaze 時連到現有 Cloud Billing 帳戶。
- [ ] 設定 Firestore、Email Link／Google provider、授權網域、伺服器 Admin 憑證與 Email 試用名單。
- [ ] 在獨立專案部署 Firestore client deny-all rules；若共用其他 App 的專案，必須先合併規則，不能直接覆蓋。
- [ ] 真實 Email 寄送、過期／錯誤連結、跨裝置確認 Email、重寄與重新登入。
- [ ] 真實 Google popup、取消、被攔截與同 Email 帳戶行為。
- [ ] 帳戶 A 不能經 API 讀寫帳戶 B 的餐點；撤銷 token 和未獲邀 Email 被拒絕。
- [ ] 兩部真實裝置離線讀寫後重連，確認新增、修改、刪除、版本衝突及自動重試。
- [ ] 檢查 Firestore 文件、hosting 日誌及網絡流量不包含圖片；無 Storage bucket 或圖片檔案新增。
- [ ] 真實 OpenAI JPEG／PNG／WebP／HEIC 分析及營養配對。

## 手機實機矩陣

| 場景 | iPhone Safari | iPhone PWA | Android Chrome | Android PWA |
|---|---|---|---|---|
| 拍照、相簿、取消、重拍、HEIC（支援時） | 待測 | 待測 | 待測 | 待測 |
| Email Link 回到原瀏覽器／PWA、Google popup、登入過期 | 待測 | 待測 | 待測 | 待測 |
| 數字鍵盤、安全區、縮放及焦點 | 待測 | 待測 | 待測 | 待測 |
| 分析取消、斷線、429、重試 | 待測 | 待測 | 待測 | 待測 |
| 安裝入口、已安裝不重複提示 | 待測 | 待測 | 待測 | 待測 |
| 離線讀寫、關閉重開、重連後自動同步 | 待測 | 待測 | 待測 | 待測 |
| 未同步修改阻止登出；更新先保留草稿 | 待測 | 待測 | 待測 | 待測 |

桌面 Edge headless 與手機寬度預覽不等同 iPhone／Android 實機。App 關閉時不保證背景同步；待同步操作在下次開啟後繼續。
