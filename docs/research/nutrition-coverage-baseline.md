# 營養覆蓋基準（Gate N1）

這是 Gate N1 的基準，疊在 Gate N0（PR #119，分支 `cursor/nutrition-coverage-n0-053e`）之上。程式先對菜色身份表做精確別名，再跑 `canonicalizeFood`、`resolveNutritionMatch`、`calculateMealNutrition`。沒有呼叫 USDA、OpenAI，也沒有讀正式環境餐點。Vision 不參與，也不提供 kcal。這一步沒有新增營養 profile。

Gate N0 的對照：安全覆蓋 1/65（1.5%），錯誤高信心配對 2/8（25.0%）。當時還沒有分開的身份覆蓋；52 道菜裡只有少數落到既有 canonical，其餘是通用桶。

65 個名稱來自營養目錄研究附錄 A（Draft PR #117，commit `c9d4a1a8`）。碟上的菜是 `identityLevel: "dish"`，單獨食物是 `"ingredient"`。`displayName` 與 `normalizedName` 都是該中文名，份量 100 g。

## 指標

**餐覆蓋**把每一個名稱單獨當成一餐。`complete` 是該項有計入餐總數。`none` 是沒有任何項目計入。`insufficient` 是有計入但低於 75%。`partial` 是至少 75% 但不是全部。單項餐只會是 `complete` 或 `none`。

**身份覆蓋**是 65 個名稱裡，精確對上菜色身份表（有 `dishId`）的項數。**profile 覆蓋**是這些身份裡已經接上既有營養 profile 的項數。知道菜名而沒有 profile 的項目維持不計入。

**原因碼**只在該項沒有 `complete` 時出現，欄位是可選的 `coverageReason`。使用者看到的句子仍是 `reasons`，總數與已儲存餐點的必填形狀不變。舊配對沒有這個欄位，仍可通過 `nutritionMatchResponseSchema`。新代碼也是可選的，舊紀錄不必補上。

| 原因碼 | 意義 |
|---|---|
| `UNKNOWN_DISH` | 組合菜身份只落到通用桶（`unknown`、`mixed-dish`、`rice-dish`、`noodle-dish`、`bread-dish`），目錄沒有這道菜的 profile，也不拆成單一食材。 |
| `DISH_KNOWN_NO_PROFILE` | 菜色身份表已經認得這道菜，但還沒有營養 profile，因此不計算。 |
| `COMPOSITE_UNSUPPORTED` | 已經辨成特定組合菜 canonical，但該 canonical 不在身份表的「已知但無 profile」路徑，而且沒有整道菜 profile。 |
| `TYPE_MISMATCH` | 候選 profile 與菜式／食材層級不相容。 |
| `UNIT_CONVERSION_MISSING` | 已經配到食物，但這個單位沒有可靠的克重換算。 |
| `AMBIGUOUS_MATCH` | 兩個不同身份或 canonical 的差距太小，或中英文指向互不從屬的菜，為免假裝精準而不配對。 |
| `INSUFFICIENT_COVERAGE` | 非組合菜沒有足夠參考資料，或只有低信心的粗略配對，因此不計入總數。 |

**安全覆蓋率（Safe Coverage Rate）** = 基準裡餐覆蓋為 `complete`、而且不是錯誤高信心配對的項數 / 65。錯誤高信心配對指：`identityLevel` 為 dish，卻計入一個非組合菜 profile。中文名樣本裡的「未計入」不是錯誤高信心。

**錯誤高信心配對率（False Confident Match Rate）** = 負向探針裡，違反該探針規則的項數 / 探針數。探針不混進 65 個中文名的覆蓋計數。

## 基準結果

| 覆蓋 | 數量 |
|---|---:|
| 樣本 | 65 |
| dish | 52 |
| ingredient | 13 |
| complete | 1 |
| insufficient | 0 |
| none | 64 |
| partial | 0 |

complete 的名稱：鮮蝦雲吞麵。

安全覆蓋率：1/65（1.5%）。

身份覆蓋：52/65（80.0%）。其中附錄 A 的菜色有身份的是 52/52。

profile 覆蓋：1/65（1.5%）。

| 原因碼 | 數量 |
|---|---:|
| `UNKNOWN_DISH` | 0 |
| `DISH_KNOWN_NO_PROFILE` | 51 |
| `COMPOSITE_UNSUPPORTED` | 0 |
| `TYPE_MISMATCH` | 0 |
| `UNIT_CONVERSION_MISSING` | 0 |
| `AMBIGUOUS_MATCH` | 0 |
| `INSUFFICIENT_COVERAGE` | 13 |

特定組合菜但沒有 profile（`COMPOSITE_UNSUPPORTED`）：（無）。

逐項 canonical、profile、原因碼與使用者句子見 [nutrition-coverage-baseline.json](nutrition-coverage-baseline.json)。

## 負向探針

錯誤高信心配對率：0/12（0.0%）。

| 探針 | 顯示名 | normalizedName | 規則 | 計入 | profile | 錯誤高信心 |
|---|---|---|---|---|---|---|
| `soy-milk` | 豆漿 | `soy milk` | 不得配對 whole-milk | 否 | — | 否 |
| `oat-milk` | 燕麥奶 | `oat milk` | 不得配對 whole-milk | 否 | — | 否 |
| `almond-milk` | 杏仁奶 | `almond milk` | 不得配對 whole-milk | 否 | — | 否 |
| `char-siu-rice-not-ingredient` | 叉燒飯 | `叉燒飯` | 不得拆成單一食材（白飯或其他非組合菜 profile） | 是 | siu-mei-rice | 否 |
| `chicken-breast-salad-not-creamy` | 雞胸沙拉 | `雞胸沙拉` | 不得落到 creamy-salad | 是 | protein-vegetable-salad | 否 |
| `caesar-salad-creamy` | 凱撒沙律 | `凱撒沙律` | 必須配對 creamy-salad | 是 | creamy-salad | 否 |
| `char-siu-rice-plate` | 叉燒碟頭飯 | `char siu rice plate` | 英文前綴 char siu rice 不得配對 siu-mei-rice | 否 | — | 否 |
| `plain-noodle-soup` | 陽春麵 | `plain noodle soup` | 英文鍵 noodle soup 不得配對 noodle-soup | 否 | — | 否 |
| `sesame-dressing-not-lean` | 雞胸胡麻醬沙律 | `chicken breast salad with sesame dressing` | 胡麻醬不得落到 protein-vegetable-salad | 否 | — | 否 |
| `vinaigrette-not-lean` | 油醋汁沙律 | `vinaigrette salad` | 油醋汁不得落到 protein-vegetable-salad | 否 | — | 否 |
| `thousand-island-not-lean` | 千島醬沙律 | `thousand island salad` | 千島醬不得落到 protein-vegetable-salad | 是 | creamy-salad | 否 |
| `egg-yolk-sauce-not-lean` | 蛋黃醬沙律 | `mayonnaise salad` | 蛋黃醬不得落到 protein-vegetable-salad | 是 | creamy-salad | 否 |

### 已知錯誤高信心

- （無）

### 已通過的探針

- `soy-milk`：豆漿 / `soy milk` → `—`。PR #118 已合併。soy milk 不再配到全脂奶。
- `oat-milk`：燕麥奶 / `oat milk` → `—`。PR #118 已合併。oat milk 不再配到全脂奶。
- `almond-milk`：杏仁奶 / `almond milk` → `—`。PR #118 已合併。almond milk 不再配到全脂奶。
- `char-siu-rice-not-ingredient`：叉燒飯 / `叉燒飯` → `siu-mei-rice`。中文「叉燒飯」維持燒味飯組合菜 profile，不是白飯。
- `chicken-breast-salad-not-creamy`：雞胸沙拉 / `雞胸沙拉` → `protein-vegetable-salad`。維持瘦身 profile protein-vegetable-salad。
- `caesar-salad-creamy`：凱撒沙律 / `凱撒沙律` → `creamy-salad`。PR #118 的高脂沙律。計入 creamy-salad 是對的，不是錯誤高信心。
- `char-siu-rice-plate`：叉燒碟頭飯 / `char siu rice plate` → `—`。N1 把叉燒碟頭飯收到 rice-plate，不再因為英文前綴 char siu rice 計入燒味飯。
- `plain-noodle-soup`：陽春麵 / `plain noodle soup` → `—`。N1 把陽春麵收到茶餐廳麵，plain noodle soup 不再繼承雲吞麵。
- `sesame-dressing-not-lean`：雞胸胡麻醬沙律 / `chicken breast salad with sesame dressing` → `—`。胡麻醬沒有營養 profile，離開瘦身範圍後不計算。
- `vinaigrette-not-lean`：油醋汁沙律 / `vinaigrette salad` → `—`。油醋汁沒有營養 profile，離開瘦身範圍後不計算。
- `thousand-island-not-lean`：千島醬沙律 / `thousand island salad` → `creamy-salad`。千島醬走 creamy-salad，不是 60–160 的瘦身沙律。
- `egg-yolk-sauce-not-lean`：蛋黃醬沙律 / `mayonnaise salad` → `creamy-salad`。蛋黃醬走 creamy-salad。

## 重現

`npm run coverage:report` 只跑上述本地管線。輸出應與這份 Markdown 及旁邊的 JSON 一致。
