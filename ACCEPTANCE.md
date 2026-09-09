# 核心流程驗收

本文件區分本機自動驗證與需要真實帳戶／裝置的驗收，未實測的項目不可標成通過。

## 本機驗證

最近一輪：209 個單元／整合測試、47 個 deterministic evaluation 案例、4 個 Edge 端到端測試全部通過。端到端使用合成帳戶及模擬雲端 API；沒有真的寄送 Email 或呼叫 OpenAI。

- [x] TypeScript、ESLint、production build。
- [x] 原有營養 calculation／canonical／coverage evaluation。
- [x] 真實 PostgreSQL 引擎執行 migration：帳戶 A／B 的餐點和照片 RLS、版本衝突、禁止刪除後復活。
- [x] API 的登入限制、儲存去重、修正快照、foreign photo rejection、照片方向／尺寸／EXIF。
- [x] IndexedDB 草稿復原、帳戶隔離及清除照片。
- [x] 375px Browser 視覺檢查、清空份量欄位及返回草稿。
- [x] 端到端：手動草稿 → OTP 模擬登入 → 儲存失敗重試 → 歷史修改／刪除；雙裝置版本衝突；PWA 離線重開；照片失敗後不保存照片。

## 必須在獨立 Supabase 試用環境完成

- [ ] 建立 KcalCue project、套用 migration、執行 Security Advisor。
- [ ] 關閉公開註冊，預建兩個試用帳戶。
- [ ] 自訂 SMTP、OTP template、HTTPS 網站與環境變數。
- [ ] 真實 OTP 寄出、錯誤碼、過期、重寄及重新登入。
- [ ] 帳戶 A 無法透過 Data API／Storage API 讀寫帳戶 B 的資料。
- [ ] 兩個裝置新增、修改、刪除及版本衝突，重新整理後一致。
- [ ] 真實 OpenAI JPEG／PNG／WebP／HEIC 分析與營養配對。
- [ ] 照片上傳失敗／清理失敗的重試，清除全部記錄後檢查私人 bucket。

## 手機實機矩陣

| 場景 | iPhone Safari | iPhone PWA | Android Chrome | Android PWA |
|---|---|---|---|---|
| 拍照、相簿、取消、重拍、HEIC（支援時） | 待測 | 待測 | 待測 | 待測 |
| OTP、前背景切換及登入過期 | 待測 | 待測 | 待測 | 待測 |
| 數字鍵盤、安全區、縮放及焦點 | 待測 | 待測 | 待測 | 待測 |
| 分析取消、斷線、429、重試 | 待測 | 待測 | 待測 | 待測 |
| 安裝入口、已安裝不重複提示 | 待測 | 待測 | 待測 | 待測 |
| 連線一次後離線關閉再開、讀取草稿 | 待測 | 待測 | 待測 | 待測 |
| 新版本提示、先保留草稿再更新 | 待測 | 待測 | 待測 | 待測 |

Browser 的 375px viewport 與桌面 Edge headless 測試不等同 iPhone／Android 實機。
