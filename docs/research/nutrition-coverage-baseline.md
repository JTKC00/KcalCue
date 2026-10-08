# 營養覆蓋基準（Gate N2）

這是 Gate N2 的基準，疊在 Gate N1（PR #120，分支 `cursor/nutrition-coverage-n1-2823`）之上。程式先對菜色身份表做精確別名，再跑 `canonicalizeFood`、`resolveNutritionMatch`、`calculateMealNutrition`。試點家族用食譜模板編成組合菜 profile。沒有呼叫 USDA live client、OpenAI，也沒有讀正式環境餐點。Vision 不參與，也不提供 kcal。模板數字來自 USDA SR Legacy（2018-04，CC0），不是模型估計。

Gate N1（#120）的對照：安全覆蓋 1/65（1.5%），profile 覆蓋 1/65，錯誤高信心配對 0/12（0.0%），`DISH_KNOWN_NO_PROFILE` 51，complete 1。身份覆蓋當時已是 52/65。

Gate N0 的對照：安全覆蓋 1/65（1.5%），錯誤高信心配對 2/8（25.0%）。當時還沒有分開的身份覆蓋。

65 個名稱來自營養目錄研究附錄 A（Draft PR #117，commit `c9d4a1a8`）。碟上的菜是 `identityLevel: "dish"`，單獨食物是 `"ingredient"`。`displayName` 與 `normalizedName` 都是該中文名，份量 100 g。

## 指標

**餐覆蓋**把每一個名稱單獨當成一餐。`complete` 是該項有計入餐總數。`none` 是沒有任何項目計入。`insufficient` 是有計入但低於 75%。`partial` 是至少 75% 但不是全部。單項餐只會是 `complete` 或 `none`。

**身份覆蓋**是 65 個名稱裡，精確對上菜色身份表（有 `dishId`）的項數。**profile 覆蓋**是這些身份裡已經接上營養 profile 的項數，包括 N2 食譜模板。知道菜名而沒有 profile 的項目維持不計入。

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
| complete | 36 |
| insufficient | 0 |
| none | 29 |
| partial | 0 |

complete 的名稱：碟頭飯、叉燒碟頭飯、燒鵝飯、油雞飯、脆皮燒肉飯、白切雞飯、海南雞飯、豬扒飯、雞扒飯、煎蛋飯、梅菜扣肉飯、滷肉飯、排骨飯、魚香茄子飯、麻婆豆腐飯、牛肉飯、乾炒牛河、星洲炒米、車仔麵、牛腩麵、鮮蝦雲吞麵、餐蛋麵、陽春麵、牛肉麵、米線、河粉、西多士、菠蘿包、叉燒包、蛋撻、腸仔蛋、糯米雞、燒賣、蝦餃、小籠包、春卷。

安全覆蓋率：36/65（55.4%）。

身份覆蓋：52/65（80.0%）。其中附錄 A 的菜色有身份的是 52/52。

profile 覆蓋：36/65（55.4%）。

| 原因碼 | 數量 |
|---|---:|
| `UNKNOWN_DISH` | 0 |
| `DISH_KNOWN_NO_PROFILE` | 16 |
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
| `char-siu-rice-plate` | 叉燒碟頭飯 | `char siu rice plate` | 英文前綴 char siu rice 不得配對 siu-mei-rice | 是 | template:char-siu-rice-plate | 否 |
| `plain-noodle-soup` | 陽春麵 | `plain noodle soup` | 英文鍵 noodle soup 不得配對 noodle-soup | 是 | template:plain-noodle-soup | 否 |
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
- `char-siu-rice-plate`：叉燒碟頭飯 / `char siu rice plate` → `template:char-siu-rice-plate`。N1 把叉燒碟頭飯收到 rice-plate。N2 用碟頭飯模板計算，profile 不是 siu-mei-rice。
- `plain-noodle-soup`：陽春麵 / `plain noodle soup` → `template:plain-noodle-soup`。N1 把陽春麵收到茶餐廳麵。N2 用茶餐廳麵模板計算，profile 不是 noodle-soup。
- `sesame-dressing-not-lean`：雞胸胡麻醬沙律 / `chicken breast salad with sesame dressing` → `—`。胡麻醬沒有營養 profile。原因碼 DISH_KNOWN_NO_PROFILE，畫面仍是暫未能計算。醬量未定，這次不加沙律醬模板。
- `vinaigrette-not-lean`：油醋汁沙律 / `vinaigrette salad` → `—`。油醋汁沒有營養 profile。原因碼 DISH_KNOWN_NO_PROFILE，畫面仍是暫未能計算。醬量未定，這次不加沙律醬模板。
- `thousand-island-not-lean`：千島醬沙律 / `thousand island salad` → `creamy-salad`。千島醬走 creamy-salad，不是 60–160 的瘦身沙律。
- `egg-yolk-sauce-not-lean`：蛋黃醬沙律 / `mayonnaise salad` → `creamy-salad`。蛋黃醬走 creamy-salad。

## 試點家族

五個家族按附錄 A 的菜數來選。菜數打平時，選香港日常菜單裡更常出現的一族。燒味飯和粥已經有 profile，而且不在這 65 個名稱裡，這次不改它們的總數。

| 家族 | 基準菜數 | 納入基準 | 需要追問 | R>3 未完成 | 選擇原因 |
|---|---:|---:|---:|---:|---|
| 碟頭飯／碗頭飯（`rice-plate`） | 16 | 16 | 0 | 0 | 附錄 A 有 16 道，是 52 道菜裡最多的一族，也是香港日常的一碟飯。燒味飯已經有 profile，而且不在這 65 個名稱裡，所以不拿這族去改它。 |
| 茶餐廳麵（`cha-chaan-teng-noodles`） | 7 | 7 | 1 | 0 | 附錄 A 有 7 道，與點心並列第二。麵、米線、河粉是茶餐廳午餐。通粉在早餐家族，不在這裡。 |
| 點心（`dim-sum`） | 7 | 7 | 0 | 0 | 附錄 A 有 7 道，與茶餐廳麵並列第二。點心是高頻港式食物。 |
| 茶餐廳早餐（`cha-chaan-teng-breakfast`） | 3 | 3 | 0 | 0 | 附錄 A 有 3 道，是前三名之後最多的一族。通粉湯也在這族，但不在 65 個名稱裡，模板仍會蓋到它。 |
| 炒河粉／炒米（`stir-fried-rice-noodles`） | 2 | 2 | 0 | 0 | 附錄 A 有 2 道，與便當、丼、拌麵、壽司打平。乾炒牛河和星洲炒米比那幾族更常出現在香港日常菜單。便當、火鍋、壽司拼盤的變異更大，這次不做。 |

全部基準菜的家族菜數：

| 家族 | 基準菜數 |
|---|---:|
| `rice-plate` | 16 |
| `cha-chaan-teng-noodles` | 7 |
| `dim-sum` | 7 |
| `cha-chaan-teng-breakfast` | 3 |
| `bento` | 2 |
| `donburi` | 2 |
| `dressed-noodles` | 2 |
| `stir-fried-rice-noodles` | 2 |
| `sushi` | 2 |
| `bibimbap` | 1 |
| `burger` | 1 |
| `fish-and-chips` | 1 |
| `hotpot` | 1 |
| `pasta` | 1 |
| `ramen` | 1 |
| `sandwich` | 1 |
| `soup` | 1 |
| `wonton-noodle-soup` | 1 |

## 與 N1 對照

| 指標 | N1（#120） | N2 |
|---|---:|---:|
| 安全覆蓋 | 1/65（1.5%） | 36/65（55.4%） |
| profile 覆蓋 | 1/65 | 36/65（55.4%） |
| 錯誤高信心配對 | 0/12（0.0%） | 0/12（0.0%） |
| `DISH_KNOWN_NO_PROFILE` | 51 | 16 |
| complete | 1 | 36 |

R 是每道菜每 100 g 熱量上限除以下限，也就是一份參考份量的熱量比。R > 2.5 標記需要後續追問（N4 才做提問介面）。R > 3 不標記完成，維持 `DISH_KNOWN_NO_PROFILE`。新 profile 的 R ≥ 2 時，配對信心維持中等。

| R | 菜數 |
|---|---:|
| ≤ 2 | 34 |
| > 2 且 ≤ 2.5 | 1 |
| > 2.5 且 ≤ 3 | 1 |
| > 3 | 0 |

需要追問：車仔麵（R=2.58）。

R > 3、未完成：（無）。

## 每道菜的 R

| 菜 | 家族 | 基準 | 每 100 g kcal | 一份 kcal | 可行總重 g | R | 追問 | 完成 |
|---|---|---|---:|---:|---:|---:|---|---|
| 碟頭飯 | 碟頭飯／碗頭飯 | 是 | 107.2–229.7 | 439.7–941.8 | 360–460 | 2.14 | 否 | 是 |
| 叉燒碟頭飯 | 碟頭飯／碗頭飯 | 是 | 141.5–186.3 | 558.9–735.9 | 360–430 | 1.32 | 否 | 是 |
| 燒鵝飯 | 碟頭飯／碗頭飯 | 是 | 137.2–188.4 | 548.7–753.5 | 360–440 | 1.37 | 否 | 是 |
| 油雞飯 | 碟頭飯／碗頭飯 | 是 | 121.3–161.1 | 497.3–660.5 | 370–450 | 1.33 | 否 | 是 |
| 脆皮燒肉飯 | 碟頭飯／碗頭飯 | 是 | 144.4–205.4 | 556.1–790.7 | 350–420 | 1.42 | 否 | 是 |
| 白切雞飯 | 碟頭飯／碗頭飯 | 是 | 122–164.2 | 494–665.1 | 370–440 | 1.35 | 否 | 是 |
| 海南雞飯 | 碟頭飯／碗頭飯 | 是 | 137.1–181.3 | 541.6–716.3 | 360–430 | 1.32 | 否 | 是 |
| 豬扒飯 | 碟頭飯／碗頭飯 | 是 | 139.9–195.7 | 587.6–822 | 380–460 | 1.40 | 否 | 是 |
| 雞扒飯 | 碟頭飯／碗頭飯 | 是 | 141–193.6 | 599.2–822.6 | 380–470 | 1.37 | 否 | 是 |
| 煎蛋飯 | 碟頭飯／碗頭飯 | 是 | 128.9–175.3 | 464.1–631.2 | 320–400 | 1.36 | 否 | 是 |
| 梅菜扣肉飯 | 碟頭飯／碗頭飯 | 是 | 129.4–178.6 | 530.7–732.3 | 370–450 | 1.38 | 否 | 是 |
| 滷肉飯 | 碟頭飯／碗頭飯 | 是 | 139.8–195.1 | 440.3–614.6 | 280–350 | 1.40 | 否 | 是 |
| 排骨飯 | 碟頭飯／碗頭飯 | 是 | 154.9–215.8 | 604–841.7 | 350–430 | 1.39 | 否 | 是 |
| 魚香茄子飯 | 碟頭飯／碗頭飯 | 是 | 108–165.3 | 448.1–685.9 | 370–460 | 1.53 | 否 | 是 |
| 麻婆豆腐飯 | 碟頭飯／碗頭飯 | 是 | 138.4–189.3 | 601.9–823.3 | 390–480 | 1.37 | 否 | 是 |
| 牛肉飯 | 碟頭飯／碗頭飯 | 是 | 135.2–186.2 | 527.2–726.3 | 350–430 | 1.38 | 否 | 是 |
| 陽春麵 | 茶餐廳麵 | 是 | 38.1–61.2 | 236–379.2 | 540–700 | 1.61 | 否 | 是 |
| 車仔麵 | 茶餐廳麵 | 是 | 46.8–120.6 | 285.2–735.8 | 540–680 | 2.58 | 是 | 是 |
| 牛腩麵 | 茶餐廳麵 | 是 | 68.2–110.1 | 429.8–693.6 | 540–720 | 1.61 | 否 | 是 |
| 餐蛋麵 | 茶餐廳麵 | 是 | 68.1–112.9 | 422.4–700.2 | 540–700 | 1.66 | 否 | 是 |
| 牛肉麵 | 茶餐廳麵 | 是 | 64.5–109.9 | 409.4–697.7 | 540–730 | 1.70 | 否 | 是 |
| 米線 | 茶餐廳麵 | 是 | 33.3–55.7 | 203–339.6 | 520–700 | 1.67 | 否 | 是 |
| 河粉 | 茶餐廳麵 | 是 | 35.9–60.8 | 212–358.8 | 500–680 | 1.69 | 否 | 是 |
| 叉燒包 | 點心 | 是 | 260–353.6 | 227.5–309.4 | 75–100 | 1.36 | 否 | 是 |
| 蛋撻 | 點心 | 是 | 185–301.3 | 140.6–229 | 62–90 | 1.63 | 否 | 是 |
| 糯米雞 | 點心 | 是 | 104.9–156.2 | 194–289 | 160–210 | 1.49 | 否 | 是 |
| 燒賣 | 點心 | 是 | 207.1–310.8 | 78.7–118.1 | 32–44 | 1.50 | 否 | 是 |
| 蝦餃 | 點心 | 是 | 130.3–208.3 | 39.1–62.5 | 24–36 | 1.60 | 否 | 是 |
| 小籠包 | 點心 | 是 | 175.2–282.5 | 77.1–124.3 | 36–52 | 1.61 | 否 | 是 |
| 春捲 | 點心 | 是 | 185.3–367.9 | 98.2–195 | 42–64 | 1.99 | 否 | 是 |
| 西多士 | 茶餐廳早餐 | 是 | 223.5–338.1 | 318.5–481.8 | 120–165 | 1.51 | 否 | 是 |
| 菠蘿包 | 茶餐廳早餐 | 是 | 278.3–413.2 | 233.8–347.1 | 70–98 | 1.48 | 否 | 是 |
| 腸仔蛋 | 茶餐廳早餐 | 是 | 208.4–306.7 | 229.2–337.4 | 95–125 | 1.47 | 否 | 是 |
| 通粉湯 | 茶餐廳早餐 | 否 | 46–83.8 | 190.9–347.8 | 350–480 | 1.82 | 否 | 是 |
| 乾炒牛河 | 炒河粉／炒米 | 是 | 115–178.2 | 390.9–605.9 | 290–390 | 1.55 | 否 | 是 |
| 星洲炒米 | 炒河粉／炒米 | 是 | 116.5–196.1 | 361–607.9 | 260–360 | 1.68 | 否 | 是 |

每項原料的克數和 FDC id 在 [nutrition-coverage-baseline.json](nutrition-coverage-baseline.json) 的 `pilot.dishes[].components`。

## 公開點值對照

對照值只核對數量級。它們是 USDA SR Legacy 的另一列食物，不是這碟的化驗，也不是目錄裡的原料加總。落在範圍外不自動判失敗；表內寫明原因。沒有使用香港食安中心或 Open Food Facts。

| 菜 | 模板每 100 g | 對照 | 對照 kcal | 落在範圍內 | 說明 |
|---|---:|---|---:|---|---|
| 碟頭飯 | 107.2–229.7 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 是 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 叉燒碟頭飯 | 141.5–186.3 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 是 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 燒鵝飯 | 137.2–188.4 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 是 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 油雞飯 | 121.3–161.1 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 否 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 脆皮燒肉飯 | 144.4–205.4 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 是 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 白切雞飯 | 122–164.2 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 否 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 海南雞飯 | 137.1–181.3 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 是 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 豬扒飯 | 139.9–195.7 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 是 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 雞扒飯 | 141–193.6 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 是 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 煎蛋飯 | 128.9–175.3 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 是 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 梅菜扣肉飯 | 129.4–178.6 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 是 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 滷肉飯 | 139.8–195.1 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 是 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 排骨飯 | 154.9–215.8 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 是 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 魚香茄子飯 | 108–165.3 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 否 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 麻婆豆腐飯 | 138.4–189.3 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 是 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 牛肉飯 | 135.2–186.2 | Restaurant, Chinese, fried rice, without meat（`fdc:167668`） | 174 | 是 | 美國中餐館無肉炒飯，只核對以飯為主的碟的數量級。 |
| 陽春麵 | 38.1–61.2 | Soup, chunky chicken noodle, canned, ready-to-serve（`fdc:171148`） | 41 | 是 | 美國罐裝塊粒雞麵湯比茶餐廳一碗麵更稀，用來核對連湯麵的下限。 |
| 車仔麵 | 46.8–120.6 | Restaurant, Chinese, chicken chow mein（`fdc:168083`） | 85 | 是 | 美國中餐館雞炒麵不是湯麵，只核對有麵有肉的數量級。 |
| 牛腩麵 | 68.2–110.1 | Restaurant, Chinese, chicken chow mein（`fdc:168083`） | 85 | 是 | 美國中餐館雞炒麵不是湯麵，只核對有麵有肉的數量級。 |
| 餐蛋麵 | 68.1–112.9 | Restaurant, Chinese, chicken chow mein（`fdc:168083`） | 85 | 是 | 美國中餐館雞炒麵不是湯麵，只核對有麵有肉的數量級。 |
| 牛肉麵 | 64.5–109.9 | Restaurant, Chinese, chicken chow mein（`fdc:168083`） | 85 | 是 | 美國中餐館雞炒麵不是湯麵，只核對有麵有肉的數量級。 |
| 米線 | 33.3–55.7 | Soup, chunky chicken noodle, canned, ready-to-serve（`fdc:171148`） | 41 | 是 | 美國罐裝塊粒雞麵湯比茶餐廳一碗麵更稀，用來核對連湯麵的下限。 |
| 河粉 | 35.9–60.8 | Soup, chunky chicken noodle, canned, ready-to-serve（`fdc:171148`） | 41 | 是 | 美國罐裝塊粒雞麵湯比茶餐廳一碗麵更稀，用來核對連湯麵的下限。 |
| 叉燒包 | 260–353.6 | Rolls, dinner, plain, commercially prepared（`fdc:172793`） | 310 | 是 | 市售餐包是皮包絡的對照，叉燒包還有肉餡。 |
| 蛋撻 | 185–301.3 | Pie, egg custard, commercially prepared（`fdc:172783`） | 210 | 是 | 市售蛋奶批比港式蛋撻更多餡、更少酥皮。 |
| 糯米雞 | 104.9–156.2 | Rice, white, glutinous, unenriched, cooked（`fdc:169711`） | 97 | 否 | 熟糯米是主料對照。加了雞和腸之後，整份應高於淨糯米。 |
| 燒賣 | 207.1–310.8 | Potsticker or wonton, pork and vegetable, frozen, unprepared（`fdc:169773`） | 136 | 否 | 急凍豬肉菜鍋貼比燒賣更多菜、更少肉。 |
| 蝦餃 | 130.3–208.3 | Potsticker or wonton, pork and vegetable, frozen, unprepared（`fdc:169773`） | 136 | 是 | 急凍豬肉菜鍋貼不是蝦餃，只核對餃子的數量級。 |
| 小籠包 | 175.2–282.5 | Potsticker or wonton, pork and vegetable, frozen, unprepared（`fdc:169773`） | 136 | 否 | 急凍豬肉菜鍋貼沒有小籠包的湯汁。 |
| 春捲 | 185.3–367.9 | Restaurant, Chinese, egg rolls, assorted（`fdc:167667`） | 250 | 是 | 美國中餐館雜錦蛋卷。 |
| 西多士 | 223.5–338.1 | French toast, prepared from recipe, made with low fat (2%) milk（`fdc:174998`） | 229 | 是 | USDA 法式吐司用低脂奶、沒有煉奶，應靠近這條範圍的下限。 |
| 菠蘿包 | 278.3–413.2 | Sweet rolls, cinnamon, commercially prepared with raisins（`fdc:175034`） | 372 | 是 | 市售肉桂甜包用來核對甜麵包的數量級。 |
| 腸仔蛋 | 208.4–306.7 | Frankfurter, pork（`fdc:172964`） | 269 | 是 | 豬肉腸是這碟的主料。加蛋之後整份密度應蓋過或接近腸本身。 |
| 通粉湯 | 46–83.8 | Soup, chunky chicken noodle, canned, ready-to-serve（`fdc:171148`） | 41 | 否 | 美國罐裝塊粒雞麵湯比火腿通粉更稀。 |
| 乾炒牛河 | 115–178.2 | Restaurant, Chinese, vegetable lo mein, without meat（`fdc:167677`） | 121 | 是 | 美國中餐館素菜撈麵沒有牛肉，用來核對炒粉麵的數量級。 |
| 星洲炒米 | 116.5–196.1 | Restaurant, Chinese, vegetable lo mein, without meat（`fdc:167677`） | 121 | 是 | 美國中餐館素菜撈麵用來核對炒粉麵的數量級。 |

## 沒有改動的既有總數

下列 profile 的每 100 g 熱量這次沒有改。鮮蝦雲吞麵、雲吞麵、湯麵仍用 `noodle-soup`。叉燒飯、燒味飯仍用 `siu-mei-rice`。白粥、皮蛋瘦肉粥仍用 `congee`。

| profile | 每 100 g kcal |
|---|---:|
| `siu-mei-rice` | 170–320 |
| `noodle-soup` | 70–160 |
| `congee` | 40–110 |
| `claypot-rice` | 170–340 |
| `milk-tea` | 45–100 |
| `rice-noodle-roll` | 110–190 |

行為變化：試點家族裡 R ≤ 3 的菜，由 `DISH_KNOWN_NO_PROFILE` 改為計入 `template:<dishId>`，而且 `composite: true`。叉燒碟頭飯會計入，但不是 `siu-mei-rice`。陽春麵會計入，但不是 `noodle-soup`。其餘家族維持不計算。組合菜不會拆成單一食材。

## 授權

這次只用 USDA FoodData Central SR Legacy（2018-04），公有領域／CC0 1.0。台灣食藥署開放資料、日本八訂成分表、加拿大 CNF 的條款仍以研究文件為準，這次沒有匯入，所以沒有觸發它們的顯名義務。香港食安中心營養資料庫只限個人非商業使用，Open Food Facts 是 ODbL，兩者都沒有用。

## 生產 QA 跟進

65 個名稱的安全覆蓋、profile 覆蓋、身份覆蓋和錯誤高信心配對沒有因為這次跟進而改變。忌廉通粉、鮮奶和燕麥牛奶粥都不在這 65 個名稱裡。

只有凍的通粉沙律才接到既有 `creamy-salad`：通粉沙律、macaroni salad，或忌廉通粉同時有沙律／凍食說明。熱食要用熱食、熱辣、焗、粟米忌廉或忌廉汁這些字，單是備註「高熱量」不會把它變成熱食。粟米忌廉通粉、焗忌廉通粉、忌廉汁通粉，以及沒有凍食說明的忌廉通粉，身份是 `cream-macaroni`，原因碼 `DISH_KNOWN_NO_PROFILE`，不計算，也不交給 USDA。目錄下限仍是 63 kcal／100 g（FDC 2706818）。畫面把一份的 kcal 向下取整到 5，所以 100 g 的高脂沙律會顯示 60，而不是 63。份量約 95–98 g 時，未進位的下限大約是 60–62 kcal。這是顯示進位，目錄數字沒有改。

胡麻醬沙律和油醋汁沙律維持不計算，原因碼是 `DISH_KNOWN_NO_PROFILE`。使用者句子說明還沒有營養 profile。醬量足以把 R 推過 3，而且不在這五個試點家族，所以這次不加模板。

名稱本身是牛奶、鮮奶、全脂奶、低脂奶、fresh milk、skim milk 或 low-fat milk，而備註、可見食材或不確定原因指向燕麥奶、豆漿或杏仁奶時，不配對 whole-milk。`POST /api/meals` 和 `POST /api/nutrition/resolve` 也不把該項交給 USDA live lookup。牛奶布甸、奶茶、牛奶麥片不會因為名稱裡有牛奶就當成牛奶；杏仁片和黃豆也不是植物奶。沒有植物奶或低脂證據時，鮮奶和 fresh milk 配對本地全脂奶，所以沒有 USDA key 的 Demo 仍可計算。低脂奶和脫脂奶不配全脂奶，沒有植物奶證據時仍可交給 USDA。燕麥牛奶粥和麥片加牛奶仍保留乳製奶。若植物奶只寫在餐點層的 visibleEvidence，食物本身沒有這些欄位，這個缺口仍然存在。

## 重現

`npm run coverage:report` 只跑上述本地管線。輸出應與這份 Markdown 及旁邊的 JSON 一致。
