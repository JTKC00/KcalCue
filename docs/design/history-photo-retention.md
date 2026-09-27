# History 圖片：最小持久化合約與分片方案

2026-09-27 完成（檔名沿用9月26日工作批次）；其後source-only分片已加入registry、meal transaction、authenticated private read route、History按需顯圖及generation字串精確JSON API object adapter（含不覆寫的建立原語）。**沒有對外上傳入口、實體cleanup及production驗收；沒有完整功能／production PASS聲明。** 未建立照片資源或更改雲端設定。

## 目標與既有基礎

讓使用者明確選擇保存本餐縮圖，日後 reload／另一裝置可在 History 查看，並在刪餐或移除圖片後停止存取。餐點的原 analysis、originalItems、current items、Daily calorieCorrection、createdAt、version/mutation/tombstone 語意保持。

本方案以以下目前 source 為基礎：

- `D`：PR20，HEAD `2a386ad7b7a393bf7b05cde9ccd98233533d545d`。`src/lib/meals/repository.ts:52–108` 先本機持久入列；`:211–244` 純 JSON meal 命令；`outbox.ts:19,27–50` 帳戶資料使用 IndexedDB transaction。
- `I`：本輪 owner 與 PR12–21 整合 snapshot；它不是已發布版本，以下路徑／行號是審查時位置。`src/lib/firebase/meals.ts:47–90` 為 Firestore transaction save；`:93–108` delete 只留最小 tombstone；`src/app/api/meals/[id]/route.ts:9` verified UID。
- 現有 `I/src/app/api/meals/photo/route.ts:13–43` **只準備圖、不保存**，已有 auth、bounded multipart、10MiB、magic MIME、40M pixels、rotate、1600 inside/no enlargement、JPEG80。`src/lib/meals/photo.ts:9–37` 為本機準備及同一路由 fallback。
- `I/src/lib/firebase/admin.ts:33` 現時只有 Auth/Firestore，沒有 object storage adapter；`SETUP.md:11,81–83`、README及UI都明示不保存圖片。這是目前真實行為，不得在未發布時改成已能保存。
- 原始使用者 §7 要求 History 圖片，授權可逆 source 演進；§20 禁止自行建立付費資源或不可逆 production mutation。本文件不把 build source bucket 當可用照片 bucket，也不假設已有私人照片 bucket/IAM。

## 1. 產品與資料合約

### 圖片內容

- 每餐最多一張目前附圖。初版不做相簿、版本照片瀏覽或永久原圖備份。
- 預設沿用「不保存圖片」；在使用者選中「儲存餐點縮圖供歷史查看」並儲存時才安排上傳。舊餐可另選照片附加，不能偷偷回收已清除草稿／舊分析圖。
- History明示「餐點附圖」；它可能是使用者後補／更換的照片，**不等於該餐最初AI分析輸入的證據**。不從附圖存在推造 analysis/model/provenance、confidence、拍攝時間或原圖身份。
- 舊 meal 沒有圖，`photoRef` 缺失或 null 都呈現「未保存餐點圖片」，正常可讀／改／刪。GET不回填，不從目前模型設定補 provenance。
- 移除圖片／換圖不改 food basis，因此不自動清除 Daily 手動 kcal；名稱／份量等既有清除規則不變。換圖也不自動重跑AI。

### 只保存標準縮圖

上傳入口沿用支援 MIME（JPEG/PNG/WebP/HEIC/HEIF）、magic bytes、multipart實讀上限、原檔10MiB及40,000,000輸入pixels；伺服器重新驗證，不能信任client說已壓縮。

固定輸出：依EXIF旋轉，長邊最多1600px、保持比例、不放大、JPEG quality80；透明輸入先以白色背景flatten，避免client/server顏色差異。輸出不保留EXIF/GPS、原檔名、相機識別或thumbnail metadata。以**單次encode**為限，輸出上限建議2MiB，超出回可理解錯誤並允許不附圖保存；不做無界降品質迴圈。這是新照片保存策略，並不改動目前AI分析送圖品質。

2MiB與1600/JPEG80是可逆MVP工程預設，實作以高雜訊／旋轉／透明fixture驗證正常輸入與上限。40M會拒絕部分48MP相機模式；保留明確提示與重新選圖／不附圖路徑，不聲稱無相容性限制。

## 2. Server-only ownership 與引用

客戶端不使用 Firebase Storage Web SDK直接讀寫；新增 Storage rules維持deny-all client（含登入者），server service identity透過最小 bucket權限存取。Admin/GCS不受client rules保護，所以所有endpoint仍須現有 authenticated() 的token撤銷、verified email、allowlist及token UID。App Check未啟用時不能以不存在的token驗證代替auth。

建議識別與命令如下（概念合約，精確名稱由實作採現有pattern）：

```ts
// Meal command：不接受bucket/object path/URL/generation/hash/owner等client claims。
photoAction?: { kind: "attach"; uploadId: string } | { kind: "remove" };
// omission = 保留previous圖；新meal omission = 無圖。

// Server-owned meal value：由asset registry複製權威欄位。
photoRef?: {
  attachmentId: string;
  generation: string;       // object service實際回覆；持久資料保留opaque字串
  contentType: "image/jpeg";
  width: number;
  height: number;
  byteSize: number;
} | null;
```

現有 `MealDraft.photo?: Blob` 保持本機用途；新增 `photoRef` 不重用這個欄位名稱或把Blob型別偷換成雲端metadata。兩者在編輯hydrate／保存ACK／清除草稿時分別處理。

- Object key由server使用verified UID、mealID、uploadID推導，例如私有namespace的固定編碼段；驗證UUID／安全編碼，不使用原檔名或client提供的path。每uploadID是一個新的immutable物件，禁止overwrite及跨meal重用。
- 圖片 registry在 `kcalcueUsers/{uid}/photoAssets/{uploadId}`，只含owner/meal綁定、reservation時固定的private bucket身分、object key、generation、checksum、尺寸bytes、server時間、state與cleanup資訊。meal引用本身不帶可公開下載的URL。已保存圖片的讀取及日後cleanup使用registry的bucket，不因目前環境變數更改而改指另一bucket。
- `attachmentId`及generation可以回client作顯示/快取識別，但不是bearer credential；即使猜中也必須經UID與目前meal引用檢查。
- 上傳重試使用固定uploadID，server先保存input bytes checksum、target meal、縮圖pipelineVersion及配額reservation。相同ID不同input拒409；同一ID不得因decode版本改變而靜默改內容。canonical JPEG checksum與generation由server在實際write時確定。
- 已用uploadID不重用；清除內容後留下最小id/state tombstone，防delayed request重建物件。它不保留照片、食物名稱、prompt或原始payload。
- 新增持久photo欄位需新的envelope version `PHOTO_SCHEMA_VERSION`。**不在文件硬佔用3**：與正在演進的analysis provenance協調選下一版本；writer接受所有明確已知舊版本，unknown仍拒絕。沒有big-bang migration。

## 3. 私人讀取路徑

已加入source-only `GET /api/meals/{mealId}/photo`；沒有配置私人bucket時維持停用，雲端實測仍是release gate。此route：

1. authenticated→verified UID scope→讀meal；已刪／無圖／不屬目前UID以不洩漏存在資訊的404返回。
2. 核對meal引用與同UID registry的mealID、attachmentID、generation、state attached一致。
3. 用**指定generation**取object，不能自動fallback最新generation。物件缺失顯示圖片暫不可用；餐點與kcal保持，不能清空其他資料或建立另一餐。
4. 回 `image/jpeg`、`Cache-Control: private, no-store`、適當nosniff；不提供公開bucket URL、永久download token或長效signed URL，不redirect到公開第三方origin。

目前安裝的Storage SDK會把指定generation轉成JavaScript Number，對0更會略去generation查詢。`photo-object-store`已用Google JSON API的字串query實作有界讀取、metadata及精確generation刪除；私有read route現已接入字串精確讀取，仍逐筆核對byteSize及SHA-256。registry finalize及meal attach亦保留合法generation為不經數字轉換的字串；emulator測試覆蓋超過2^53的值。**cleanup runner未接線，沒有真實bucket parity**。404可能是bucket設定錯誤，adapter不把它當物件已刪或釋放quota。完成generation-aware cleanup、真實bucket讀刪及設定驗收前，不得啟用照片功能。

History由使用者點「查看餐點附圖」後才以authorized fetch→Blob/object URL顯圖，避免進入舊餐列表時批量下載；相同attachment/generation的同步快照不重抓。account generation change／unmount／換圖立即取消請求、撤銷object URL並清掉舊帳戶state。SW繼續不攔截`/api/`，不把照片放公共shell cache。初版只保證已登入且連線可重新取cloud圖片；不悄悄新增永久離線history圖片cache。

**刪除時序界線：**tombstone完成後新進的read會拒絕；已在刪除前通過授權並開始下載的bytes無法收回，也不能抹掉使用者曾保存的截圖。可在stream前再讀revision降低競態，但不能承諾遠端既得副本被撤銷。

## 4. Upload → meal save：跨系統狀態機

Firestore與object storage不能做同一個transaction。meal引用與registry的`state=deleting`可在同一Firestore transaction原子改動；這個registry狀態本身是持久、可重試的cleanup work item，不宣稱two-system atomic upload或物件已刪除。

建議registry狀態：`uploading → staged → attached → deleting → deleted`；`uploading/staged`過期可轉deleting，deleting不可重新attach。所有分支以CAS／transaction檢查實際前一狀態，不能靠client cache。

### Upload

- 使用**新route**（例如 `POST /api/meals/{mealId}/photo-uploads/{uploadId}`）做可持久上傳；不要把現有`/api/meals/photo?prepare=1`預覽準備改成有storage side effect。
- auth、feature/config、bounded body、MIME/pixels驗證後，交易式建立／讀固定uploadID的reservation，驗server總量/UID配額、同meal關聯及delete tombstone。若meal尚未存在，允許為該UID的新UUID暫存；若已deleted拒絕。
- Encode後以「物件不存在才建立」generation precondition寫canonicalJPEG。**generation precondition exact SDK/API用法在實作時依安裝版本驗證**，本文件未呼叫雲端或外部文件，不提供未查證可直接執行的CLI。
- 寫成功才以storage回覆generation/checksum更新staged；reservation→bytes accounting保持有上限，不在unknown狀態提前釋放額度。
- Source-only `photo-object-store.create`使用multipart/related及`ifGenerationMatch=0`，帶入不可變key與input/JPEG checksum、尺寸metadata；它**不建立reservation，也不自動重試**，尚未有呼叫它的上傳route。成功回覆會按實際generation回讀JPEG並核對byteSize/SHA-256，因為自訂metadata的checksum只是上載時提供的字串；回覆遺失或不符一律當unknown，由後續recovery對同一key做metadata及實際bytes驗證。
- 若storage回覆逾時／中斷，不產生新uploadID重傳。先以同ID查serverstatus及同object key metadata，確定generation/checksum；存在且吻合則補finalize，確定不存在才以相同precondition重試；無法確定則保留pending。
- 若發現object metadata不符reservation，fail closed、記非私人diagnostic，不能overwrite不明物件或把它attach。

### Attach（沿用 meal save）

- Client收到stagedACK後，以原餐點mutationID送既有meal命令加`photoAction.attach(uploadId)`。同一mutation的內容一旦送出不可改寫。
- Meal POST可先preflight，但**commit transaction內再次讀meal與asset**；維持tombstone、same-mutationACK、schema、expected version與UID guards，並驗asset staged/未過期、正確meal、generation已確定。所有Firestore讀取在寫入之前。
- 同transaction寫meal新photo、asset attached及account revision；若替換舊photo，同時把舊asset標deleting，留下持久cleanup work item。沒有先刪舊object再保存新meal的窗口。
- 已ACK的mutation直接回原record，不重attach、不改version/createdAt、不重算provenance。並發另一裝置勝出時409，staged新圖仍不公開，等使用者明確處理或expiry清理。
- Omitted photoAction保留previous photoRef（舊client只改餐別不丟圖）；remove明確置null並安排cleanup。Client偽造photoRef字段直接strip；只有registry可提供server photoRef。
- Conflict「保留為新餐」不得把舊asset/ref移到新ID。初版清除已保存照片引用並說明需重新附圖；只有本機仍有實際Blob且使用者選擇附圖時，才建立新的uploadID。不做隱式server copy或共享reference counting。

## 5. Delete、orphan與補償

### 正式刪餐／移除圖片

DeleteMeal transaction保留目前version/mutation/tombstone防復活語意，同時把已引用asset標deleting。該asset registry文件的固定路徑和`state=deleting`就是deterministic cleanup work item；meal tombstone仍只留原有最小meal狀態，object cleanup資訊留在server-only asset。

DELETE ACK表示餐點與圖片引用已不可再新讀，不表示storage實體位元已完成刪除。UI不用因此把餐點留在History；隱私文案需說明背景實體清理。資料刪除的資料庫transaction失敗時，不能先物理刪object。

Cleanup只delete該asset記錄的**確切generation**；precondition mismatch不得刪最新版或未知object。現在的source-only `cleanupKnownPhotoGeneration` 只在精確DELETE成功後退還quota；404仍屬未知結果，因一次404也可能是bucket/IAM設定問題。日後必須有可審核的bucket身分與缺席證明，才可在已刪但HTTP回覆遺失的情況完成quota核銷。Retry重用同asset，不新增mealmutation、不復活引用。

同mutation DELETE重試仍ACK；即使第一個HTTP回覆遺失，asset的deleting狀態已與tombstone原子存在。一般500/網絡錯誤採有限每輪重試及backoff，不因一輪失敗清掉durable work item。永久權限／配置錯誤保留工作並告警，不靜默成功或無界緊迴圈。

### Orphan與晚到的upload

- 建議staged/尚未attach的upload最長24小時；expiry以server clock與固定建立時間為準，不能靠重試無限延長。
- Cleaner先transaction將過期uploading/staged轉deleting，與attach競爭同一asset文件。若attach先完成則不可刪；若cleanup先取得deleting則attach拒絕。不能只list完就delete。
- **晚到write問題：**upload可能在cleanup標記後才完成，甚至object建立後process crash、尚未寫回generation。Upload finalizer重讀state，若已deleting/deleted立即把自己實際建立的generation交cleanup，絕不回staged。
- 不能僅假設finalizer一定會跑。定期server reconciler須對expired uploading/deleting做generation-aware HEAD；並有限批次核对object namespace與asset registry，找object已存在但finalize缺失／meal已tombstone的情況。reserved key不可reuse，最小tombstone及持久清理游標讓晚到object仍可再次被找到。
- 不對同一object prefix套「24小時全刪」bucket lifecycle：staged後會attach並保持相同key，這樣會誤刪正常History圖。若未來拆staging/attached prefix則需copy/finalize另一套補償，**不放進第一版**。
- attached物件保留到使用者detach/delete或明確account lifecycle；不暗中按短TTL刪正常歷史圖。既有帳戶刪除若尚無產品流程，須把對應object清理列release runbook，不能讓storage資料游離於資料擁有人生命週期。

**實體清理需要可信的背景執行者。** Request-after-response、只有使用者再登入時順手清理或process內setTimeout都不能保證清理。Source-only per-asset原語、逾期`uploading/staged`掃描及`deleting`掃描已存在；兩個有界scanner分別持久化游標、掃至尾端回繞，並逐筆從document path重驗owner。逾期掃描只把Registry交易式轉成`deleting`，不直接刪object。`deleting`且generation未知時，掃描器只會在同一固定bucket/key查到物件、核對reservation與指定generation的實際JPEG bytes後補記generation，再按精確generation刪除；404／讀取失敗／不符仍保留工作及quota。這仍未涵蓋registry已標`deleted`後才出現、且finalizer未回來的晚到write；需另以有界namespace對帳找出。`docs/design/photo-assets-indexes.example.json`列出所需索引範本，**未接入firebase.json／未部署**；啟用前須核對既有雲端索引，再安全合併。尚無可信排程／監測、完整晚到write對帳及404缺席證明，**不能稱實體cleanup已運作**。沒有已授權scheduler/執行環境前，不得宣稱有24h刪除SLA；新付費排程/worker資源須授權，且是啟用photo retention的release gate。時間目標建議每15分鐘有限批次、pending逾24h告警；這是待配置驗收的目標，不是目前承諾。

## 6. 離線、本機原子性與unknown outcome

- 延用per-UID Web Locks、account generation guards、每meal有序outbox、固定mealmutation/uploadID。用 `photoAction`／本機upload dependency表示意圖，不能把Blob、base64、object URL塞入meal JSON。
- 新增同一`kcalcue-sync` IndexedDB內的`photoPayloads` store，鍵含UID/uploadID；meal job＋upload intent＋compressedBlob以**同一IDB transaction**持久化。這次照片能力確實需要IDB schema upgrade，不能照抄metadata PR的「無需upgrade」結論。
- 原draft在另一`kcalcue-private` DB：先確認上述job/payload transaction成功才清draft。兩DB不能同transaction；失敗時寧可留duplicate draft/payload待回收，不可先清Blob導致無圖可重試。quota-full／IDB failure清楚提示且保持原draft。
- Save時尚未上傳，UI應顯「已保留本機；餐點及附圖待同步」，**不稱已保存到雲端**。Upload成功才放行該meal save；其他meal jobs可以繼續，不讓一張壞圖擋全帳戶。
- Upload失敗允許明確「不附圖儲存餐點」。若meal POST確定尚未dispatch，可以取消原未送意圖、用新的mealmutation儲存無圖餐點並安排staged cleanup；不得改寫任何已dispatch/unknown的mutation payload。若已送且結果unknown，先以同mutation恢復ACK／確認結果，再以新的versioned remove操作處理。
- Abort／refresh只停止目前client等待，不代表server upload沒發生；恢復依固定IDs查status再重試。未確定的object也不能提前refundquota。
- 多個離線edit保留每個命令的原始IDs/expectedVersion；同一meal的upload/attach dependency按序完成。明確error只阻該meal後續工作；discard須沿已有uid locks/generation與新photo dependencies一起驗證，不能誤丟另帳戶Blob。
- 本機Blob在meal attach ACK、明確discard或使用者不附圖保存後才清除。登出不得靜默丟掉pending photo；延用pending jobs須處理的規則。切帳戶不得顯示舊object URL。
- 既有saved History圖初版不保證離線可看；網絡失敗時保留meal資料、顯示圖暫不可用與重試。未送照片payload的本機storage pressure風險文案沿現有offline說明。

## 7. Cost、retention及隱私啟用

- 上傳不是AI呼叫，不使用分析token作唯一quota，也不因附圖自動重跑AI。沿auth後獨立UID upload admission，限制bytes、pixels、頻率、inflight、pending數。
- 建議私人試用初值：同UID一個upload in-flight、容量5/每分鐘回填、最多5個未attach reservation；每張canonical圖≤2MiB。另必須配置UID與全project durable byte quota，reservation＋used bytes在Firestore transaction計算，unknown仍占額。**沒有明確quota設定時不得預設unlimited並開啟功能。** 總bytes上限需按既有試用人數及獲准budget設定，不以本文件替owner授權新增費用。
- 不對整個bucket作每request listing或把照片放Firestore；lazy-load可見的History卡片、取消離屏讀取、同session對相同attachment/generation去重。原始照片及canonical bytes不寫logs，安全diagnostic只記stage、大小、耗時和非私人error類別。
- 保存圖前明確說明只保存縮圖、用於History、可移除、刪除後實體清理可能延遲；AI傳送說明與History保留說明分开。不能保持「圖片不保存到雲端」同時偷偷開啟寫入。
- 寫入flag與讀取/刪除功能分離：`photoUploadsEnabled=false`只停止新上傳，不停止既有photo auth-read、detach/delete或cleanup。關閉flag不能丟棄未處理工作；UI允許不附圖繼續記餐。
- 新bucket的soft-delete/versioning/retention policy會影響physical erasure與成本，必須在release前實際讀回並納入隱私文案；不能把generation delete回覆當所有backup位元即刻銷毀。本輪不讀雲端也不變更該政策。

## 8. Release與rollback gate

1. Source/local tests與PR可在現有授權範圍準備；不需要先拿productionsecret。付費Storage/scheduler、IAM、rules、CORS（若server-only則不需client跨域上傳）、productionflags/config及正式隱私行為變更，依實際授權release。
2. 新schema guard保護edit，但**不足以保護delete**：舊版`deleteMeal`允許正常刪future-schema餐點，卻不會把photo asset標deleting。因此所有active/rollback delete、detach、photo-read writer都須具備新lifecycle能力；不可只說「舊v2會拒schema所以安全」。Reconciler亦須能發現舊／異常路徑產生的meal tombstone＋attachedasset。
3. 先部署相容writer/read/delete/cleanup、驗證私人拒絕与cleanup執行，再最後開upload flag。此前UI仍表示圖片不會保存；只在enable後提供opt-in並使用新文案。
4. Rollback先停新uploads，保持既有photo讀取／刪除／cleanup及new schema保護。不能route回忽略photo欄位的整份replace writer；不能以刪bucket／照片作回滾。
5. 启用後只以QA帳戶做真縮圖upload→meal attach→GET→reload/History→replace→detach/delete→generation cleanup readback；不觸碰真實使用者資料。沒有cloud resource/config驗證時，整項標「source ready，未啟用／未production驗收」。

## 9. 可本機驗證的必要cases

| 層級 | 最小有意義驗收 |
|---|---|
| Image pipeline | 正常五格式／損壞bytes／MIME spoof／空檔／缺或偽Content-Length；40M及輸出2MiB界線；1600長邊/no-upscale/aspect、EXIF旋轉、GPS移除、透明白底；拒絕時object writer零呼叫。nativeHEIC codec與手機原圖另外標示實際coverage。 |
| Auth/private reads | 未登入/未驗email/未allowlist拒；A拿B的mealID/uploadID/path/generation都取不到；client Storage rules全拒；匿名URL無access；tombstone後新read拒；account ABA回來不接舊Blob continuation。 |
| Upload idempotency | 同ID同bytes一物件；同ID不同bytes409；create回覆遺失後status/HEAD恢復；checksum/generation mismatch不覆寫；unknown不釋額；staleupload completion不復活deletedasset。 |
| Transactions | staged attach成功；兩meal/兩UID不能共享；expectedVersion/future schema拒；same mutation原ACK無writes；originalanalysis/provenance/createdAt/kcal不改；omit保留圖、remove排cleanup；replace原圖直到commit仍可讀。 |
| Cleanup race | attach先勝不刪；expiry先勝attach拒；delete與upload finalize交錯；delete ACK遺失重試；404與generation mismatch；storage500/denied留下job；lateobject與missingfinalize由reconciler找到；不掃刪其他UID。 |
| Offline/outbox | job＋Blob交易一起commit/abort；兩DB清draft前crash；reload同IDs；networkunknown；同meal依序、其他meal可過；IDB quota full保draft；未dispatch選不附圖、已dispatch先recover；logout阻pending及跨帳戶清理。 |
| Daily/provenance相容 | 附圖／換圖／移除不改手動kcal或AI model來源；改food仍清correction；legacy無圖；舊queue省略保留圖；copy-as-new不共享asset；malformedpersistedphoto顯不可用而非crash／假數據。 |
| Browser synthetic | 明確opt-in與off文案；保存後reload/History顯圖；private fetch含auth、沒公開URL；replace／delete；offline圖不可用但meal可編輯；375px焦點/CTA；console/network預期錯誤有處理。 |

使用fake object store驗證generation/unknown/error時序、Firestore emulator驗證真transaction/rules；Storage emulator如可用補client-denied與object read/write。**emulator不證明實際GCS generation/IAM/soft-delete/lifecycle行為**，real cloud parity保留release gate。全部fixture用公開或合成圖，不需私人meal或付費provider。

## 10. 最小PR順序

1. **合約＋server primitive（預設disabled）：**typed asset/command/schema、fake object adapter、transaction reservation/attach/remove/cleanup狀態機、ownership與meaningful tests；普通meal與既有prepare route行為不变。不單獨啟用未有cleanup的upload endpoint。
2. **可恢復 server lifecycle：**實際server-only object adapter、generation conditional operations、private read、upload/status、cleanup runner/reconciler及provider-specific本機測試；與step1整合emulator。沒有實際資源/config也可完成可審核source，cloud parity明列待驗。
3. **Client vertical slice：**History按需private blob rendering已有source-only分片；仍需IDB payload store、outbox依赖／unknown recovery、opt-in、replace/remove、legacy/離線UX、Daily/provenance相容，以及獨立browser重做完整journey。同步更新條件式隱私文案與SETUP，不把預設disabled寫成已發布。
4. **授權release：**確認資源、quota、delete/retention/IAM與背景執行；exact-source CI/build/codec證據、rollback floor；QA帳戶真流程＋cleanup readback後才標功能production PASS。

前三步可按實際diff大小再拆，但不能把「能upload」當成可發布feature而留下ownership、delete、unknown recovery待日後。也不為此加入大型admin、相簿、AI重分析、公開分享、billing或原圖永久保存。
