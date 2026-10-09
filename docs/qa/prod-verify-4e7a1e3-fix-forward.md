# #124 生產 QA fix-forward 交接

Base：`main @ 4e7a1e3900b4c5dc1bc32d3ecccc0f74d724b4b5`。來源：James 提供的 `prod-verify-4e7a1e3`，生產 revision `kcalcue-00041-laj`。
本次只做程式修正與 Draft PR。沒有 merge、deploy、Firebase／Cloud Run 設定變更或正式環境 AI 呼叫。

## 根因與結果

| 項目 | 本機狀態 | 證據 |
| --- | --- | --- |
| A 奶類通知 | PASS | 分析端以前沒有產生 `otherMilkNotice`，共用 schema 也未保留它；UI 只為「其他」顯示通知。現在分析端產生植物奶通知，共用 schema／推導出的 client types／保存的 analysis 保留它，食物卡顯示兩種通知。API 測試涵蓋泛稱牛奶、oat milk、oat beverage 紙盒，以及明確同一份的合併；ResultView 與 E2E 驗證顯示。 |
| B 植物奶選擇 | PASS | 原本只有全脂參考，植物奶負向規則會阻擋乳製奶，沒有相應參考資料。明確 chooser 選擇現在使用獨立 USDA 參考。250 ml 燕麥奶 115–120 kcal，無糖豆漿 80–85 kcal，均計入總數；API resolve／save、單元及 360／375 px E2E 驗證，編輯後 `userMilkTypeChoice` 保留。 |
| C 容器誤合併 | PASS | 原本同類包裝字樣或相同名稱／備註足以觸發合併；fallback 也可能忽略不同容器。現在需要明確同一份的證據。紙盒＋玻璃杯、前／後玻璃杯保留兩列；模型已回傳一列而 visibleEvidence 顯示多容器時，加 `duplicateMilkNotice` 讓使用者新增／拆分。單一玻璃杯仍一列；不相加合併份量。 |
| 既有回歸 | PASS | chooser 五個按鈕；全脂 250 ml、手動鮮奶仍 155–160 kcal 且納入總數；360／375 px 無水平溢出；植物奶不配全脂，沒有新增模型 kcal 欄位。全部既有測試保留。 |
| 修正後正式照片／生產 QA | NOT CHECKED | 本次沒有部署；此結果是合成 vision 回傳、API boundary、client rendering 及本機 E2E 的驗證，不能當作已修復正式 revision 的證據。 |

## 營養來源

2026-10-09 直接讀取 USDA FoodData Central 官方 API：

- [FDC 175215](https://fdc.nal.usda.gov/food-details/175215/nutrients)，SR Legacy：Soymilk (all flavors), unsweetened, with added calcium, vitamins A and D。每 100 g：33 kcal、蛋白質 2.86 g、碳水 1.74 g、脂肪 1.61 g；1 cup = 243 g。
- [FDC 2705412](https://fdc.nal.usda.gov/food-details/2705412/nutrients)，Survey (FNDDS)：Oat milk。每 100 g：45 kcal、蛋白質 0.66 g、碳水 5.37 g、脂肪 2.33 g；1 cup = 244 g、1 fl oz = 30.5 g。這是通用燕麥奶參考，沒有聲稱為無糖品牌標籤。
- USDA 沿用 repo 的公有領域／CC0 attribution。[USDA 資料文件](https://fdc.nal.usda.gov/data-documentation/)；ml 以 household cup 克重及 [NIST US customary cup 換算](https://www.nist.gov/pml/special-publication-811/nist-guide-si-appendix-b-conversion-factors/nist-guide-si-appendix-b9)推導。計算及 5 kcal 顯示進位沿用現有程式。
- 新參考只由使用者明確選擇啟用。未確認的模型植物奶名稱仍沿用既有 fail-closed 規則；不放寬成全脂奶，也不從 AI 取得熱量。

## 驗證

- 新測試先在 base 執行，重現通知缺漏、oat／soy resolver 不計入及 distinct-container 合併的失敗；同一份合併與單杯基準通過。
- `npm test`：55 files，934/934 PASS（新增 17 tests）。
- `npm run eval`：93/93 cases PASS。
- `npm run typecheck`：PASS。
- `npm run lint`：PASS，0 errors；13 個既有 warnings。
- `npm run test:e2e`：43/43 PASS（既有 38，加 5）。含 production build PASS，全部使用合成帳戶及攔截的 Firebase／cloud API。
- 360 px 燕麥奶、375 px 豆漿畫面已回讀；四個植物奶 viewport 案例均檢查 scrollWidth，chooser、計算、save、再次 edit 皆通過。
- GitHub exact-head CI 以 Draft PR checks 為準；本機通過不代替 CI。
- JEV 僅用合成容器描述做輔助語意判斷；沒有傳送程式、私人 repo 資料、照片或帳戶資料。驗收依據為上述 deterministic tests。

## 修改檔案

- `src/app/api/analyze/route.ts`
- `src/app/api/analyze/route.test.ts`
- `src/app/api/nutrition/resolve/route.test.ts`
- `src/app/api/meals/route.test.ts`
- `src/components/kcalcue-app.tsx`
- `src/components/food-editor.tsx`
- `src/components/result-view.test.tsx`
- `src/lib/domain/food-analysis.ts`
- `src/lib/domain/editable-meal.ts`
- `src/lib/domain/milk-dedupe.ts`
- `src/lib/domain/photo-milk-analysis.ts`
- `src/lib/nutrition/local-data.ts`
- `src/lib/nutrition/resolver.ts`
- `src/lib/nutrition/photo-milk.test.ts`
- `src/lib/providers/food-vision/prompt.ts`
- `e2e/journal.spec.ts`
- `docs/qa/prod-verify-4e7a1e3-fix-forward.md`
