# 營養目錄擴充研究：減少「暫未能計算」

規劃日期：2026-10-08  
狀態：研究與計劃。本文件不改 catalog、resolver、UI 或任何 runtime。不合併、不部署。  
核對基準：`main` `5b25b0b9d0f6a8078418ddb3861eadedbf68aa35`（PR #116 已合併；該 PR 新增組合菜 profile `protein-vegetable-salad`）。  
產品原則沿用 README 與 [DECISIONS.md](../../DECISIONS.md)：精準呈現不確定性，而不是假裝精準。AI 只辨認食物與份量，kcal 只來自營養層。

請求裡的「磟頭飯」按港式**碟頭飯**理解。

## 1. 建議

**第一個 PR 先修 PR #116 的沙律規則，不要先接新的營養 API。**

`protein-vegetable-salad` 的上限是 **60–160 kcal／100 g**。名稱裡同時有蛋白質或蔬菜，又有通粉、沙律醬或凱撒時，這條規則仍會套用該上限。USDA FoodData Central 的 Survey foods（FNDDS）已公布：美乃滋通粉沙律 **221 kcal／100 g**（FDC `2708932`），芝士通粉沙律 **246 kcal／100 g**（FDC `2708947`）。160 的上限低於這兩個點值，屬於低估，比「暫未能計算」更違反現有誠實規則。

修法：這些名稱退出瘦身沙律 profile；另設一條有 FDC id、上限至少蓋過 246 kcal／100 g 的高脂沙律 profile。原有「燒烤蛋白質雜菜沙律碗」維持 60–160。細節見第 6 節。

**真正減少「暫未能計算」的下一步，是沿用現有 curated composite profile，為「整碟一道菜」加寬範圍，而不是先擴充原料庫。**

原因：

- Vision prompt 要求已命名的組合菜維持**一個** `identityLevel: "dish"`，不要拆成飯、肉、菜、醬。
- Resolver 規定 dish 只能配對**同一個** `canonicalName` 的 composite profile。沒有該菜式的 profile 時，結果是 `unresolved`，不會退回白飯或雞胸。
- 可選的 USDA live fallback **直接拒絕** composite identity，有 `NUTRITION_API_KEY` 也不會查碟頭飯。

所以原料目錄再大，也解不開模型按契約交回來的「一碟燒鵝飯」。原料擴充解決的是旁邊單獨可見的西蘭花、蝦、牛油果，以及使用者把菜名改成單一食材的情況。

不建議把 Open Food Facts、食安中心 NIIS、中國食物成分表或商業 API 混進現有目錄。授權結論見第 4 節。

## 2. 現有系統

### 2.1 資料放在哪裡

| 部分 | 位置 | 行為 |
|---|---|---|
| 本地目錄 | `src/lib/nutrition/local-data.ts` | 32 個 `NutritionProfile`。其中 13 個 `composite: true`。瀏覽器內 `LocalNutritionProvider` 離線配對。 |
| 標準名稱 | `src/lib/nutrition/canonical.ts` | `canonicalizeFood()`。詞彙規則，不是把每個模型句子寫成 alias。 |
| 配對 | `src/lib/nutrition/resolver.ts` | 評分後只讓 high／medium 進入餐總數。 |
| 菜式／食材相容 | `src/lib/nutrition/compatibility.ts` | dish 對 ingredient 一律不相容。dish 對 dish 必須 `canonicalName` 相同。 |
| 計算 | `src/lib/nutrition/calculation.ts` | 份量範圍 × 每 100 g 密度範圍。`complete`／`partial`（已計入 ≥ 75%）才顯示餐總數。 |
| 可選 USDA | `src/lib/nutrition/usda.ts` | 只在本地 unresolved 的 **非 composite**、單位為 g 時查詢。 |
| 文案 | `src/content/zh-HK.ts` | 餐總數無法顯示時標題是「暫未能計算」。逐項無資料是「未有足夠資料」。 |
| 來源顯示 | `src/components/result-view.tsx` | 「營養資料來源」列出已計入項目的 `source.sourceName`。 |
| 回歸契約 | `src/lib/evaluation/fixtures.ts` | `npm run eval`。不呼叫 OpenAI 或 USDA，也不鎖定精確 kcal 真值。 |

每個 profile 已有 `source`（`provider`、`sourceId`、`sourceName`、`attribution`）、`dataNotice`、`densityBasis`，以及 `nutrientsPer100g` 的 min／max。組合菜的密度是「公開熟食或原料值，加上已寫明的烹調不確定性」，不是該碟的化驗值。這是 DECISIONS 第 14、22、25 節的現行決定。

基準上的 13 個 composite profile：`dumpling-cooked`、`fried-rice`（170–300 kcal／100 g）、`fried-noodles`（160–320）、`curry-rice`（150–330）、`braised-rice`（150–320）、`baked-rice`（170–360）、`siu-mei-rice`（170–320）、`claypot-rice`（170–340）、`noodle-soup`（70–160）、`congee`（40–110）、`rice-noodle-roll`（110–190）、`milk-tea`（45–100）、`protein-vegetable-salad`（60–160）。其餘 19 個是單一食材。

### 2.2 一道菜怎樣變成 `none`

1. 搜尋文字是 `displayName`、`normalizedName`、`preparationMethod`、`visibleIngredients` 串在一起。短的中文單字（例如「飯」「麵」）必須是去掉烹調詞之後剩下的全部，避免「墨魚汁意大利飯」因為「飯」變成白飯。
2. 已命名菜式（炒飯、叉燒飯、火鍋、pizza……）或 `identityLevel: "dish"` 會帶上 `composite`。飯加肉、麵加醬這類跨類組合，若沒有更具體的菜名，會合成 `rice-dish`、`noodle-dish`、`bread-dish` 或 `mixed-dish`。白飯、蒸飯仍是 `rice`。
3. Composite identity 只可以配對 `composite: true` 且 `canonicalName` 相同的 profile。沒有這條 profile，或分數低於 50，就回傳 `profile: null`、`matchType: "unresolved"`、`includedInTotal: false`。原因句是「找到相近的基礎食材資料，但不足以代表整道菜，因此未納入總數。」
4. `UsdaNutritionClient.resolve()` 見到 composite identity 就同樣回這句，**不會發 API request**。
5. 整餐 `includedCount === 0` 時 coverage 是 `none`。大於 0 但低於 75% 是 `insufficient`。兩者都不顯示餐總數，畫面標題是「暫未能計算」。逐項則是「營養資料」加「未有足夠資料」。

因此「暫未能計算」在組合菜上是規格，不是配對失敗的意外。PR #116 只讓**名稱本身**已表明是蛋白質或蔬菜沙律的菜，改走一條寬範圍。

### 2.3 誠實規則（擴充時仍然有效）

- 不把 LLM 生成的數字寫進目錄。
- 不為每一道餐廳菜加 alias，也不把所有含「飯」的名稱都當成 unresolved 或都當成白飯。
- 港式奶茶不得套用全脂奶。火鍋、果汁、pizza、只有「沙律」二字的名稱，維持沒有專屬 profile 就不計算。
- Golden test 不宣稱精確 kcal 真值。可以鎖定 identity、有沒有計入、coverage，以及「範圍必須蓋過某個已引用的公開點值」。
- 營養配對結果存在餐點紀錄裡。日後若為 `NutritionSource` 加欄位，必須是可選欄位，舊紀錄仍要通過 `response-schema`。

## 3. 量到的覆蓋缺口

量測日：2026-10-08。程式是基準上的 `canonicalizeFood`、`resolveNutritionMatch`、`calculateFoodNutrition`。份量固定 100 g，單位 `g`。沒有呼叫 USDA、OpenAI，也沒有讀正式環境餐點。探針測試沒有留在這個 PR。

這不是使用者餐點的頻率分布。正式環境不記錄食物名稱（DECISIONS 第 20 節），這份研究也不建議為了統計覆蓋率而開始記錄菜名。

### 3.1 現有 eval 契約

`representativeEvaluationCases` 共 **49** 個。契約中的 coverage：

| coverage | 案例數 |
|---|---:|
| `complete` | 34 |
| `none` | 14 |
| `insufficient` | 1 |
| `partial` | 0 |

`none` 的 14 個是故意不計算的項目：單獨「沙律」、果汁、一般咖喱、pizza、無名混合菜、無法辨認的名稱、意大利飯、火鍋、carbonara、肉醬意粉、laksa、意大利飯加帶子，以及 PR #116 的水果沙律。`insufficient` 是香蕉加 pizza。

這組案例**偏向目錄已經認識的食物**（白飯、雞胸、炒飯、叉燒飯、腸粉、奶茶都在裡面）。34／49 complete 不能當成香港餐單的覆蓋率。

### 3.2 香港組合菜樣本（中文名本身）

65 個名稱。碟上的菜用 `identityLevel: "dish"`，單獨食物用 `"ingredient"`。`displayName` 與 `normalizedName` 都是該中文名，避免英文翻譯裡碰巧出現 `milk`、`noodle soup`、`char siu rice`。名單見附錄 A。

| 結果 | 數量 |
|---|---:|
| 樣本 | 65 |
| 被標成 composite identity | 52 |
| 有計入餐總數 | **1** |
| 未計入 | **64** |

唯一計入的是「鮮蝦雲吞麵」→ `noodle-soup`。因為名稱包含已有鍵「雲吞麵」。其餘碟頭飯、便當、燒鵝飯、油雞飯、海南雞飯、豬扒飯、滷肉飯、車仔麵、牛肉麵、拉麵、乾炒牛河、壽司、火鍋、漢堡、點心，中文名本身都是 `unresolved`。

52 個組合菜 identity 裡面，51 個沒有可用 profile。這是「暫未能計算」的主缺口。13 個單獨食物（西蘭花、牛油果、蝦仁、雞翼、豆漿等）同樣沒有 profile。這些是原料庫的缺口，而且不會被 USDA 的 composite 禁令擋住。

### 3.3 中英雙語會改變配對

Resolver 同時看中文顯示名和英文 `normalizedName`。針對幾個容易撞名的寫法再跑一次：

| 顯示名 | normalizedName | 結果 |
|---|---|---|
| 豆漿 | `soy milk` | **計入 `whole-milk`**。英文 token `milk` 命中全脂奶。中文「豆漿」單獨則是 unresolved。 |
| 叉燒碟頭飯 | `char siu rice plate` | **計入 `siu-mei-rice`**。英文鍵 `char siu rice` 是這個詞組的前綴。中文「叉燒碟頭飯」單獨是 `mixed-dish`，不計入。碟頭飯的菜汁和餸菜比例未必落在燒味飯 170–320 的範圍內。 |
| 陽春麵 | `plain noodle soup` | 英文鍵 `noodle soup` 會計入 `noodle-soup`（70–160）。改成 `plain soup noodles` 則不計入。 |
| 雞翼 | `chicken wings` | identity 是 `chicken`，雞胸與雞腿分數太接近，維持 unresolved。這個平手是對的。中文「雞翼」單獨連 `chicken` 都對不上。 |

之後的名稱層要用顯式同義詞，不能靠短英文 token 或「鍵是前綴就算命中」。

### 3.4 沙律規則實際套到哪裡

`isProteinVegetableSalad()` 要求名稱有沙律／salad，而且沒有水果、薯、意粉、pasta 等排除詞；然後「沙律碗」或蛋白質／蔬菜詞其一成立即可。`visibleIngredients` 不能單獨促成配對。排除詞**沒有**通粉、macaroni、沙律醬、mayo、凱撒、caesar。

同一套 100 g 探針：

| 名稱（顯示名／英文） | 是否計入 | profile | kcal／100 g |
|---|---|---|---|
| 沙律／salad | 否 | — | — |
| 沙律碗／salad bowl | **是** | `protein-vegetable-salad` | 60–160 |
| 雜菜沙律 | **是** | 同上 | 60–160 |
| 燒烤蛋白質雜菜沙律碗 | **是** | 同上 | 60–160 |
| 水果沙律、薯仔沙律、意粉沙律 | 否 | — | — |
| 通粉沙律／macaroni salad | 否 | — | 沒有蛋白質詞，所以沒套用 |
| 吞拿魚通粉沙律／tuna macaroni salad | **是** | 同上 | **60–160** |
| 凱撒沙律／caesar salad | 否 | — | 沒有蛋白質詞 |
| 凱撒雞沙律／chicken caesar salad | **是** | 同上 | **60–160** |
| 沙律醬／mayonnaise | 否 | — | — |
| 雜菜沙律伴沙律醬 | **是** | 同上 | **60–160** |
| chicken mayo salad | **是** | 同上 | **60–160** |

「沙律碗」三個字、沒有蔬菜或蛋白質詞，也會因為 `SALAD_BOWL` 套用 60–160。生產環境那碗「燒烤蛋白質雜菜沙律碗」仍然應該用這一條，因為名稱裡有燒烤、蛋白質、雜菜。

## 4. 資料來源與授權

查證日：2026-10-08。只採用當日從官方頁面讀到的條款。沒有整包下載台灣、英國或加拿大資料來點算菜式數目，因此**不宣稱**這些資料庫已經收錄碟頭飯或燒臘飯。

### 4.1 適合做原料，或做組合菜的密度依據

| 來源 | 授權與義務 | 取得方式 | 語言與覆蓋 | 對 KcalCue |
|---|---|---|---|---|
| USDA FoodData Central，含 SR Legacy、Foundation Foods、FNDDS Survey foods | 公有領域，[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/)。無須許可。官方**請求**註明出處，並建議引用 “U.S. Department of Agriculture, Agricultural Research Service. FoodData Central. fdc.nal.usda.gov”。見 [API Guide](https://fdc.nal.usda.gov/api-guide/)。 | API：`https://api.nal.usda.gov/fdc/v1/`，要 data.gov API key。預設 **1,000 requests／hour／IP**，超出後該 key 暫停 1 小時（HTTP 429）。`DEMO_KEY` 只有 30／hour、50／day。另有整包下載（API Guide 的 Download Data）。 | 英文。FNDDS 是美國膳食調查的**混合菜**（炒飯、通粉沙律、凱撒沙律、congee、pizza、湯）。港式茶餐廳名稱很弱：查 “char siu” 回到的是醬料品牌，不是叉燒飯。 | **最適合繼續當密度基準。** 新的組合菜範圍應引用具體 FDC id，而不是在請求當下為 composite 開 live search。Live fallback 維持只查原料、只納入 g。 |
| 台灣衛福部食藥署「食品營養成分資料集」 | [政府資料開放授權條款第 1 版](https://data.gov.tw/license)。不限目的（含商業）、可改作、可再授權、免授權金。**必須**按附件做顯名聲明（機關、資料集名稱與版本、條款 URL）；沒做顯名視為自始未授權。條款寫明與 CC BY 4.0 相容。資料集頁：[data.gov.tw/dataset/8543](https://data.gov.tw/dataset/8543)（頁面詮釋資料更新時間 2026-10-05，更新頻率寫每 3 個月）。 | 開放資料 CSV／JSON／XML（ZIP）。查詢網站：[食品營養成分資料庫](http://consumer.fda.gov.tw/Food/TFND.aspx?nodeID=178)。 | **繁體中文食物名。** 對 zh-TW 別名最有用。港式用詞（通粉、沙律、碟頭飯）仍要人工對照，不能假設台灣菜名等於香港菜名。 | **原料擴充的第二來源。** 匯入的每一筆要帶版本號與顯名句子。不要假設裡面有可靠的茶餐廳組合菜。 |
| 日本文部科學省「日本食品標準成分表（八訂）増補 2023 年」 | 官方頁寫明食品成分資料可自由使用。書籍、論文、**應用程式**等二次使用要標明出典：「日本食品標準成分表（八訂）増補2023年から引用（又は出典）」。見 [成分表首頁](https://www.mext.go.jp/a_menu/syokuhinseibun/index.htm)。Q&A 亦寫應用程式無須另申請許可，但要把「八訂成分表」標給使用者。 | Excel 與 PDF，可下載。沒有以 API 配對菜名的必要。 | 日文。八訂加強了調理済み食品，比純原料接近組合菜（例如炒飯、拉麵一類，仍要以表內條目為準，不能憑菜名猜想）。沒有中文名。 | **組合菜寬範圍的輔助依據**，適合人工對上某一個表內食品再加不確定性。不要機器翻譯後自動入庫。 |
| 加拿大 Canadian Nutrient File 2026 | [Open Government Licence – Canada](https://open.canada.ca/en/open-government-licence-canada)。允許商業使用。署名例：“Contains information licensed under the Open Government Licence – Canada.” 資料集頁標明該授權，紀錄修改日 2026-10-04：[open.canada.ca 資料集](https://open.canada.ca/data/en/dataset/1b6139bd-ed7e-4043-bc28-ff00e10f3109)。 | ZIP／CSV 整包。 | 英文／法文。加拿大常見食物，不是香港組合菜。 | 可作原料補充。優先順序低於 USDA 與台灣資料集，因為沒有中文名，也與 USDA 重疊。 |
| 英國 CoFID 2021 試算表（McCance and Widdowson） | GOV.UK 出版物：[CoFID](https://www.gov.uk/government/publications/composition-of-foods-integrated-dataset-cofid)（最後更新 2021-03-19）。User guide 頁尾是 © Crown copyright 2021。Quadram 的 [FAQ](https://fnnbri.quadram.ac.uk/help/) 寫 Excel 資料按 Open Government Licence 使用，須註明出處（FAQ 連結的是 OGL v1；現行文本是 [OGL v3](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/)）。 | 只使用 GOV.UK 上的 2021 Excel。 | 英文。含食譜計算食品，仍是英國食物。 | 只在 USDA／台灣沒有對應原料時才引用，並在 profile 上分開標 Crown copyright／OGL。 |

**不要使用 Quadram 的 CoFID API。** 其 2026-06 技術文件第 9.3 節寫 API 與所提供資料是 [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)，**禁止商業使用**，衍生作品亦要相同授權。見 [CoFID API PDF](https://fnnbri.quadram.ac.uk/wp-content/uploads/2026/06/CoFID_API_Technical_Documentation.pdf)。KcalCue 若要英國資料，只用 GOV.UK 試算表。

### 4.2 不匯入現有目錄

| 來源 | 當日讀到的限制 | 為何不合 |
|---|---|---|
| 香港食安中心 Nutrient Information Inquiry System | [英文首頁](https://www.cfs.gov.hk/english/nutrient/index.php) 寫明免費，但 “The information provided is for **personal non-commercial use** and reference.” 資料混合中國疾控、USDA、FSANZ、泰國 Mahidol 的庫，並另有 [FSANZ 使用者協議](https://www.foodstandards.gov.au/science-data/monitoringnutrients/afcd/datauserlicenceagreement)。 | 產品使用不符合「個人非商業」。經 NIIS 轉手不會洗掉上游授權。港式食物名雖然最貼地，這一版不能當匯入來源。 |
| 中國疾控／《中國食物成分表》 | 查詢平台寫資料版權歸營養與健康所，並寫明未經該所允許不得作商業用途（[平台說明](https://www.chinanutri.cn/yyzyxxpt/sjzx/swcfsjk/201911/t20191128_207183.html)、[食物頁聲明](https://nlc.chinanutri.cn/fq/foodinfo/1545.html)）。標準版是出版圖書，不是開放資料。 | 沒有可商用的開放授權。中文原料名有參考價值，但不能抄進目錄。 |
| Open Food Facts | 資料庫 [ODbL](https://opendatacommons.org/licenses/odbl/1-0/)，內容 DbCL，圖片 CC BY-SA。官方說明：可商用，但公開使用要署名；**把 OFF 和其他資料庫合併後，合併庫必須以開放資料釋出**，而且只能和允許再散佈的來源合併。見 [使用條款](https://world.openfoodfacts.org/terms-of-use)、[數據頁](https://world.openfoodfacts.org/data)、[API 說明](https://openfoodfacts.github.io/openfoodfacts-server/api/)。API：讀單品約 15 requests／min／IP，搜尋約 10／min／IP；大量使用應下每日匯出，不要用 API 抓全庫。 | Share-alike 會碰到現時隨程式發佈、且混有人工範圍的目錄。內容是包裝食品標籤，眾包質素參差，幾乎沒有碟頭飯這種現煮組合菜。相片餐點流程不採用。將來若做條碼，必須放在**另一個**資料庫，不能寫回 `local-data.ts`。 |
| 澳洲 FSANZ Australian Food Composition Database（AFCD；NUTTAB／AUSNUT 在其協議定義裡被分開點名） | [Data User Licence Agreement](https://www.foodstandards.gov.au/science-data/monitoringnutrients/afcd/datauserlicenceagreement)：以 CC BY-SA 3.0 Australia 為底，另加條款。可商用，但衍生作品要以同一協議散佈，並附 limitation 聲明，以及 “based on Australian data and Australia data may not be appropriate for use in other countries”。 | Share-alike 與「澳洲資料未必適用於其他地方」都不利於混進香港餐點目錄。不採用。 |
| 新加坡 HPB Singapore Food Insights Database（原 FOCOS） | 公開工具頁：[SG FoodID](https://www.hpb.gov.sg/healthy-living/food-and-beverage/sgfoodid/)（頁面寫 2026-06-19 更新）。FAO 只登記為可搜尋的免費工具。該頁**沒有**寫明可再散佈或可商用的授權。 | 未見到 HPB 自己的再使用許可之前，不匯入、不抓取。東南亞熟食覆蓋值得以後再問，但不能靠「網站查得到」推斷可以複製。 |
| Nutritionix | [開發者首頁](https://developer.nutritionix.com/) 寫已取消公開免費 tier，商業或研究要另外申請有限 trial。 | 沒有可離線複製進目錄的開放授權。就算日後有合約，也只可按該合約當 live lookup，不能把回應用來建成第二份目錄。 |
| Edamam | [Nutrition Analysis API 文件](https://developer.edamam.com/edamam-docs-nutrition-api) 描述的是付費 B2B：每條新食譜按月累計授權費，並用 ETag 避免重複計費。 | 不是自由資料。食譜 NLP 可以分解菜式，但計價單位和「離線、可重算、不把模型數字當營養」的邊界不合。不採用。 |
| FatSecret Platform | [價目與版本](https://platform.fatsecret.com/api-editions)：Basic 免費 5,000 calls／day，**只得美國資料、英文**，要署名。Premier Free 給符合資格的新創，仍是美國資料且要署名。多國資料與 26 種語言在付費 Premier。 | 免費層解不了香港中文組合菜。它是 API 服務，不是可併入程式的開放資料庫。不把回寫進 catalog。 |

FAO／INFOODS 是各國食物成分表的索引，不是單一授權。韓國、泰國等表這一輪沒有核到可商用的官方條款，不列入採用名單。

### 4.3 公開點值（用來檢查沙律上限）

2026-10-08 經 FDC API 讀到的每 100 g 能量。這些是資料庫點值，不是 KcalCue 該碟的化驗。

| FDC id | 資料類型 | 名稱 | kcal／100 g |
|---|---|---|---:|
| 2708932 | Survey (FNDDS) | Macaroni or pasta salad, made with mayonnaise | **221** |
| 2708947 | Survey (FNDDS) | Macaroni or pasta salad with cheese | **246** |
| 2708933 | Survey (FNDDS) | Macaroni or pasta salad, made with light mayonnaise | 159 |
| 171009 | SR Legacy | Salad dressing, mayonnaise, regular | 680 |
| 2709591 | Survey (FNDDS) | Caesar salad, with romaine, no dressing | 77 |
| 2706818 | Survey (FNDDS) | Chicken or turkey caesar garden salad, no dressing | 63 |
| 2710199 | Survey (FNDDS) | Caesar dressing | 542 |
| 2708951 | Survey (FNDDS) | Rice, fried, meatless | 174 |
| 2708418 | Survey (FNDDS) | Congee | 39 |

FNDDS 把凱撒沙律和醬分開列，沒有在這次搜尋裡給出「連醬一碟」的單一食品。用表內點值做比例說明：80 g 無醬凱撒沙律（77 kcal／100 g）加 20 g 凱撒醬（542 kcal／100 g），混合物是 **170 kcal／100 g**，已高於 160。這是說明醬量足以越界，不是新的目錄數字。

對照現有範圍：FNDDS 素炒飯 174 落在炒飯 170–300 之內；FNDDS 白粥 39 就在粥 40–110 的下限旁邊。寬範圍要定期用這類點值檢查，下限太高會輕微高估很稀的版本，上限太低會低估油和醬。

## 5. 建議架構

Runtime 維持現狀：瀏覽器本地配對、composite 不可退回原料、USDA 只做原料 fallback、餐總數門檻 75%、改份量只重算。新資料在**建置時**收成現有的 `NutritionProfile` 範圍，不新增第二套即時計算。

### 5.1 原料目錄與匯入

優先來源：USDA bulk（CC0）、台灣食藥署開放資料（OGDL）、需要熟食對照時加日本八訂成分表。CNF 與 CoFID 2021 Excel 只補缺。

每一筆保留：

- `sourceId`（FDC id 或台灣樣品編號）
- `license` 與 `licenseUrl`（新欄位，寫入已保存餐點時必須可選）
- `attribution`（給「營養資料來源」和關於頁的顯名句子）
- `retrievedAt` 與資料集版本
- `densityBasis`：點值就寫 min = max，並註明未包含烹調差異；有油、熟度或品種差異才展開成範圍

匯入程式只負責抽出「每 100 g 的能量、蛋白質、碳水、脂肪齊全」的列，產生待審核 diff。**人審過的別名**才進 `canonical.ts` 與 profile。禁止把整庫自動接上 resolver。短詞（`milk`、`rice`、`醬`、`麵`、`汁`）不得當自動別名。

第一批原料應是樣本裡 unresolved 的單獨食物：西蘭花、牛油果、蝦、魚、雞翼、午餐肉、芝士、豆漿、燕麥、乳酪、油條。豆漿必須是自己的 profile，不能再被 `soy milk` 配到全脂奶。雞翼要用自己的 canonical，避免再在雞胸／雞腿之間打平。

### 5.2 組合菜：模板編成寬範圍

兩層，最後都變成 `composite: true` 的 profile。

1. **食譜比例模板（建置時編譯）。** 例如碟頭飯可以記成：飯 45–65%、燒味或肉 20–40%、菜與醬 10–25%（數字只是形狀例子，實作時每一格都要有出處）。每一格指向已授權的原料 profile。編譯器把「比例範圍 × 密度範圍」加成每 100 g 的 min／max，寫進目錄。`densityBasis` 列出比例與 FDC id。Runtime 不再拆菜。
2. **類別寬範圍。** 湯水比例或配料種類不穩定時（車仔麵、便當、火鍋），用一條很寬的 profile，或不做。這就是現在炒飯、粥、燒味飯的做法。

納入餐總數的條件：

- 菜名 canonical 與 profile 相同（維持現有相容規則）。
- 範圍蓋過**所有**寫進 `densityBasis` 的公開點值。做不到就不要配對這個名稱，讓它繼續 unresolved。
- 能量 max／min ≥ 2 的新 profile，配對信心維持 **medium**，不要標成 high。現有炒飯等 profile 的 high 先不要改，避免同一 PR 改動已經上線的信心標示。
- max／min 大於約 2.5，或絕對差距大到總數沒有參考價值（便當、火鍋、壽司拼盤這一級）時，**不要納入餐總數**。可以在逐項顯示「範圍太寬，未計入」，但那是文案變更，應獨立 PR。在那之前，維持今日的 unresolved。

火鍋、pizza、一般咖喱、只有「沙律」二字，繼續不要為了減少「暫未能計算」而硬做一條窄範圍。

### 5.3 中英港台名稱

- 顯式同義詞表：zh-HK、zh-TW、英文、需要時日文。例子：番茄／蕃茄、乳酪／優格、通粉／macaroni／通心粉、沙律／沙拉、碟頭飯 ≠ 叉燒飯。
- 字形轉換（裡／裏、臺／台）可以做，但轉換結果只等於同一個已審核名稱，不用來猜測營養。
- 英文配對改為整鍵比對。`char siu rice` 不應命中 `char siu rice plate`，除非表內明確有這個較長名稱。
- `soy milk`、`oat milk`、`coconut milk` 在加入任何奶類別名之前要有測試，確認不會變成 `whole-milk`。
- Vision 的 `identityLevel` 仍是菜式／食材的權威。名稱層不推翻它。

### 5.4 怎樣同時避免低估和高估

低估的現況是組合菜變成 `none`，畫面誠實地說不能算。新的危險是算出一個太窄的範圍。

- **下限太高**：很稀的粥、湯很多的麵，會被共用範圍的下限抬高。FNDDS congee 39 對上本地 40 就是邊界。共用 profile 前，先把最淡和最濃的已引用點值都放進測試。
- **上限太低**：沙律 160 對上通粉沙律 221／246。任何新上限都要有一條測試：被這條 profile 接受的名稱，其 kcal max ≥ 所引用公開點值的最大值。
- **配錯家族**：豆漿 → 牛奶、碟頭飯 → 燒味飯、港式奶茶 → 全脂奶。每一條新別名要有負向案例。
- **油和醬**：模板的脂肪上限要包含可見的淋油、醬和炸皮。沒有這項證據的名稱不要用瘦身版本。
- **湯**：連湯進食的密度可以很低。湯麵一類要保留高湯水比例的下限，不能只用乾麵的密度。
- 不使用模型臨時報出的 kcal 來「校正」目錄。

範圍寬度已經用「約 270–1120 kcal」這種 min–max 表示。新的寬 profile 應把現有 `densityBasis` 的原因顯示出來（醬、油、配料未能由相片確定），不要只顯示「營養資料：高」。Journal UI 的決定仍然有效：不能為了好看而藏起 partial／unknown 的句子。

### 5.5 署名要出現在哪裡

現有側欄「營養資料來源」繼續列出 `sourceName`。另外在關於頁放一段不會隨「這餐沒有計入項目」而消失的聲明：

- USDA：FoodData Central，CC0；建議引用見 API Guide。
- 台灣資料：政府資料開放授權條款的三行顯名（機關、資料集名稱與版本、`https://data.gov.tw/license`）。缺了這段，授權視為自始無效。
- 日本資料：上列八訂増補 2023 的出典句。
- 加拿大或英國資料若用到，分別加 OGL-Canada 或 Crown copyright／OGL 句子。

不要把食安中心、中國食物成分表、OFF 或 FSANZ 的名字放進這段，除非日後真的取得並遵守該授權。

## 6. PR #116 沙律規則的修補

問題不在「燒烤蛋白質雜菜沙律碗」這條生產案例。問題是排除詞只擋了香蕉、水果、薯、意粉／pasta、啫喱，沒有擋高脂變體，而蛋白質詞（`tuna`、`chicken`、吞拿、雜菜）又足以打開 60–160。

建議在同一個小型 PR 做兩件事：

1. **瘦身 profile 的排除詞**至少包括：`macaroni`、通粉、通心粉、`mayo`、`mayonnaise`、沙律醬、蛋黃醬、千島、`caesar`、凱撒、`dressing`（作為醬，而不是 “no dressing” 這種否定；實作時要用詞組測試，避免誤傷）。「沙律碗」單獨不再足夠，必須同時有蔬菜或蛋白質詞。生產案例「燒烤蛋白質雜菜沙律碗」仍命中原 profile。
2. **高脂沙律 profile**（新 canonical，例如 `creamy-salad`）只在名稱含通粉／macaroni、沙律醬／mayo，或凱撒／caesar 時使用。密度引用第 4.3 節的 FDC id。上限至少 **246 kcal／100 g**，並在脂肪上限反映美乃滋（680 kcal／100 g、脂肪 74.8 g／100 g）只佔一部分、而不是整碟都是醬。下限不要低到把無醬凱撒（77）假裝成同一碟；無醬與有醬若不能由菜名分辨，範圍就要同時蓋過 77 和 246，並接受這條範圍很寬、信心為 medium。

測試（加入 eval，不鎖定某一餐的精確 kcal）：

- 燒烤蛋白質雜菜沙律碗 → `protein-vegetable-salad`，計入，100 g 時熱量上限為 160。
- 水果沙律、薯仔沙律、意粉沙律、單獨「沙律」→ 不計入。
- 吞拿魚通粉沙律、凱撒雞沙律、雜菜沙律伴沙律醬、`chicken mayo salad` → **不得**再使用 60–160。若高脂 profile 啟用，100 g 熱量上限 ≥ 246，而且 canonical 不是 `protein-vegetable-salad`。
- 通粉沙律（沒有蛋白質詞）若仍 unresolved，可以接受；不要為了讓它有數字而套回瘦身 profile。

在高脂 profile 的點值測試寫好之前，只做排除、讓這些名稱回到「暫未能計算」，也比繼續顯示 60–160 正確。兩個都做是為了不把已辨認的高脂沙律全部打回 `none`。

## 7. 分期

每一期都是可以獨立合併的 PR，附測試或 eval。不在這些 PR 裡部署。

### P0 — 沙律高脂排除與高脂 profile（先做）

- 改動：`canonical.ts` 的沙律判斷、`local-data.ts` 一條新 profile、eval／unit。
- 授權：沿用 USDA CC0，在 `densityBasis` 寫 FDC id 與取數日期。
- 風險：高脂上限若只寫到 246，特多芝士或特多醬仍可能低估。測試鎖的是「不得低於已引用點值」，不是保證所有餐廳。
- 規模：一個小型 PR。不改 USDA client、不改餐點 schema。

### P1 — 港式「一碟一道菜」的寬範圍

沿用 P0 的「範圍必須蓋過引用點值」和負向別名測試。建議順序：

1. 燒臘飯一類：燒鵝飯、油雞飯、脆皮燒肉飯。不要默默塞進現有 `siu-mei-rice`（170–320）。皮和淋油可能更肥。要麼擴闊該 profile 並改測試，要麼新 canonical，並確認「叉燒碟頭飯」不會只因英文前綴撞進燒味飯。
2. 有名字但沒有 profile 的：海南雞飯、拉麵、牛肉麵、車仔麵。牛肉麵不可用雲吞麵 70–160 的上限，除非引用點值證明足夠。
3. 繼續不做：便當、火鍋、壽司拼盤、pizza、果汁。變異太大。

每個 PR 二至四條 profile 為限。授權仍是 USDA 公開值加已記錄的不確定性；若某條用了日本八訂的調理済み食品，該 profile 的 attribution 改寫出典句，不要標成 USDA。

風險：別名再一次比「飯」「麵」更寬。負向案例要包括白飯、陽春麵的中文名，以及第 3.3 節的英文前綴。

規模：每批一個中型 PR。這是第一個會明顯減少組合菜 `none` 的步驟。

### P2 — 原料匯入管線與一小批食材

- 加入可選的授權欄位與顯名句子（關於頁，不一定只在有計入項目時出現）。
- 匯入腳本加來源 manifest（資料集版本、下載日、授權 URL、內容雜湊）。腳本輸出 diff，不直接覆蓋 `local-data.ts`。
- 第一批只匯入第 5.1 節列出的十項左右，每項有中英別名和「不會配錯」的測試。豆漿與 `soy milk` 是必須的回歸。
- 台灣 OGDL 的顯名聲明在關於頁完成後，才可以合併任何台灣來源的 profile。

風險：目錄變大之後，雞胸／雞腿這種「分數差小於 12 就放棄」會更常出現。那是保護，不要為了提高命中率而調低門檻。Composite 禁令的測試要原樣保留。

規模：一個中型 PR（格式與十項食材）。全庫匯入不是這一期。

### P3 — 把一個食譜模板編譯成 profile

選海南雞飯或碟頭飯做範本：比例表、引用的原料 id、編譯出的 min／max、以及「點值落在範圍外就失敗」的測試。Runtime 仍然只讀編譯結果。

比例若沒有出處，就不要編譯進會納入總數的 profile。沒有出處的類別維持 P1 的寬範圍，或者繼續 unresolved。

規模：一個中型 PR。之後每道菜才是複製這個範本的小 PR。

### P4 — 名稱表與英文整鍵比對

把第 3.3 節的撞名收成回歸，再改比對。可以分兩步：先加負向測試（現在會失敗的先不要寫進會紅的 CI，除非同一 PR 修掉），然後改 `textContainsKey` 的英文前綴行為。這一步會改變配對，必須單獨 PR，並重跑 `npm run eval`。

不在這一步引入模糊搜尋或用模型選 profile。

## 8. 這一輪明確不做

- 不改程式、目錄或正式環境。
- 不把 composite 重新打開 USDA live search。
- 不記錄菜名來做覆蓋率統計。
- 不把「暫未能計算」改成一個沒有來源的中間值。
- 不為便當、火鍋、壽司拼盤製造窄範圍。

## 附錄 A — 中文樣本（65）

碟上的菜以 dish 配對：碟頭飯、叉燒碟頭飯、午餐便當、日式便當、燒鵝飯、油雞飯、脆皮燒肉飯、白切雞飯、海南雞飯、豬扒飯、雞扒飯、煎蛋飯、梅菜扣肉飯、滷肉飯、排骨飯、魚香茄子飯、麻婆豆腐飯、牛肉飯、親子丼、牛丼、石鍋拌飯、乾炒牛河、星洲炒米、車仔麵、牛腩麵、鮮蝦雲吞麵、餐蛋麵、冬蔭功湯、拉麵、擔擔麵、炸醬麵、陽春麵、牛肉麵、米線、河粉、西多士、菠蘿包、叉燒包、蛋撻、腸仔蛋、糯米雞、燒賣、蝦餃、小籠包、春卷、壽司拼盤、壽司、火鍋、漢堡、三文治、肉醬意粉、魚柳薯條。

單獨食物以 ingredient 配對：果汁、凍檸茶、油條、西蘭花、牛油果、蝦仁、蒸魚、雞翼、午餐肉、芝士、豆漿、燕麥、乳酪。

除「鮮蝦雲吞麵」外，以上中文名在基準程式都未計入。
