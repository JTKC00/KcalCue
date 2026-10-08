# 營養覆蓋基準（Gate N0）

這是 Gate N0 的基準，對照合併 PR #116 之後的本地目錄與 resolver。程式是 `canonicalizeFood`、`resolveNutritionMatch`、`calculateMealNutrition`。沒有呼叫 USDA、OpenAI，也沒有讀正式環境餐點。Vision 不參與，也不提供 kcal。

65 個名稱來自營養目錄研究附錄 A（Draft PR #117，commit `c9d4a1a8`）。碟上的菜是 `identityLevel: "dish"`，單獨食物是 `"ingredient"`。`displayName` 與 `normalizedName` 都是該中文名，份量 100 g。

## 指標

**餐覆蓋**把每一個名稱單獨當成一餐。`complete` 是該項有計入餐總數。`none` 是沒有任何項目計入。`insufficient` 是有計入但低於 75%。`partial` 是至少 75% 但不是全部。單項餐只會是 `complete` 或 `none`。

**原因碼**只在該項沒有 `complete` 時出現，欄位是可選的 `coverageReason`。使用者看到的句子仍是 `reasons`，總數與已儲存餐點的必填形狀不變。舊配對沒有這個欄位，仍可通過 `nutritionMatchResponseSchema`。

| 原因碼 | 意義 |
|---|---|
| `UNKNOWN_DISH` | 組合菜身份只落到通用桶（`unknown`、`mixed-dish`、`rice-dish`、`noodle-dish`、`bread-dish`），目錄沒有這道菜的 profile，也不拆成單一食材。 |
| `COMPOSITE_UNSUPPORTED` | 已經辨成特定組合菜 canonical，但沒有整道菜 profile，因此拒絕退回單一食材。 |
| `TYPE_MISMATCH` | 單位沒有可靠克重換算，或候選 profile 與菜式／食材層級不相容。 |
| `AMBIGUOUS_MATCH` | 兩個不同 canonical 的分數差距小於 12，為免假裝精準而不配對。 |
| `INSUFFICIENT_COVERAGE` | 非組合菜沒有足夠參考資料，或只有低信心的粗略配對，因此不計入總數。 |

**安全覆蓋率（Safe Coverage Rate）** = 基準裡餐覆蓋為 `complete`、而且不是錯誤高信心配對的項數 / 65。錯誤高信心配對指：`identityLevel` 為 dish，卻計入一個非組合菜 profile。中文名樣本裡的「未計入」不是錯誤高信心。

**錯誤高信心配對率（False Confident Match Rate）** = 負向探針裡，`includedInTotal` 為 true 且違反該探針規則的項數 / 探針數。已知、本基準不修復的錯誤仍然計入分子。探針不混進 65 個中文名的覆蓋計數，因為那些撞名靠的是英文 `normalizedName`，附錄 A 的量測沒有把它們算進去。

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

| 原因碼 | 數量 |
|---|---:|
| `UNKNOWN_DISH` | 46 |
| `COMPOSITE_UNSUPPORTED` | 5 |
| `TYPE_MISMATCH` | 0 |
| `AMBIGUOUS_MATCH` | 0 |
| `INSUFFICIENT_COVERAGE` | 13 |

特定組合菜但沒有 profile（`COMPOSITE_UNSUPPORTED`）：石鍋拌飯（bibimbap）、拉麵（ramen）、火鍋（hotpot）、三文治（sandwich）、肉醬意粉（bolognese）。

逐項 canonical、profile、原因碼與使用者句子見 [nutrition-coverage-baseline.json](nutrition-coverage-baseline.json)。

## 負向探針

錯誤高信心配對率：5/7（71.4%）。

| 探針 | 顯示名 | normalizedName | 規則 | 計入 | profile | 錯誤高信心 | #118 預期清除 |
|---|---|---|---|---|---|---|---|
| `soy-milk` | 豆漿 | `soy milk` | 不得配對 whole-milk | 是 | whole-milk | 是 | 是 |
| `oat-milk` | 燕麥奶 | `oat milk` | 不得配對 whole-milk | 是 | whole-milk | 是 | 是 |
| `almond-milk` | 杏仁奶 | `almond milk` | 不得配對 whole-milk | 是 | whole-milk | 是 | 是 |
| `char-siu-rice-not-ingredient` | 叉燒飯 | `叉燒飯` | 不得拆成單一食材（白飯或其他非組合菜 profile） | 是 | siu-mei-rice | 否 | 否 |
| `chicken-breast-salad-not-creamy` | 雞胸沙拉 | `雞胸沙拉` | 不得配對 creamy／高脂沙律 profile | 是 | protein-vegetable-salad | 否 | 否 |
| `char-siu-rice-plate` | 叉燒碟頭飯 | `char siu rice plate` | 英文前綴 char siu rice 不得配對 siu-mei-rice | 是 | siu-mei-rice | 是 | 否 |
| `plain-noodle-soup` | 陽春麵 | `plain noodle soup` | 英文鍵 noodle soup 不得配對 noodle-soup | 是 | noodle-soup | 是 | 否 |

### Draft PR #118 預期清除

- `soy-milk`：豆漿 / `soy milk` 現時計入 `whole-milk`。英文 token milk 命中全脂奶。中文「豆漿」單獨不會。
- `oat-milk`：燕麥奶 / `oat milk` 現時計入 `whole-milk`。與豆漿相同的 milk token。
- `almond-milk`：杏仁奶 / `almond milk` 現時計入 `whole-milk`。與豆漿相同的 milk token。

### 已知錯誤高信心，#118 不清除

- `char-siu-rice-plate`：叉燒碟頭飯 / `char siu rice plate` 現時計入 `siu-mei-rice`。研究 3.3 的英文前綴撞名。Draft PR #118 不處理這條。
- `plain-noodle-soup`：陽春麵 / `plain noodle soup` 現時計入 `noodle-soup`。研究 3.3 的英文前綴撞名。Draft PR #118 不處理這條。

通過的負向規則（不計入分子）：中文「叉燒飯」不得變成白飯；「雞胸沙拉」不得配到 creamy／高脂沙律。後者在這份基準已經是 `protein-vegetable-salad`，不是高脂 profile。

## 重現

`npm run coverage:report` 只跑上述本地管線。輸出應與這份 Markdown 及旁邊的 JSON 一致。
