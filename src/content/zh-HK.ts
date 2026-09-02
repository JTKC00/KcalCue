export const copy = {
  brand: "KcalCue",
  tagline: "影低你嘅一餐，快速了解大概卡路里。",
  heroTitle: "一張相，睇清一餐嘅大概範圍。",
  heroBody:
    "KcalCue 會辨認相片中嘅食物，再用合理範圍估算卡路里同主要營養素。你亦可以隨時修正食物或份量。",
  rangePrinciple: "以範圍表達，不扮精準",
  takePhoto: "影相分析",
  choosePhoto: "選擇相片",
  analyze: "開始分析",
  replacePhoto: "更換相片",
  removePhoto: "移除相片",
  demoTitle: "目前為示範模式",
  demoBody: "未有實際 AI 圖片分析。你可完整體驗結果、修正同重新計算。",
  demoPrivacy: "示範模式下，相片只留喺你部裝置作預覽。",
  liveTitle: "AI Live Mode",
  liveBody: "相片會經 KcalCue server 暫時傳送至已設定嘅 AI 圖片分析服務，不會由 KcalCue 保存。",
  manualTitle: "手動輸入",
  manualBody: "結果只根據你輸入嘅食物同份量計算，並非 AI 圖片分析。",
  privacyShort: "相片只用於今次分析，KcalCue 不會建立相片紀錄或持久保存。",
  selectedTitle: "相片準備好喇",
  selectedBody: "檢查相片清楚見到整餐，再開始分析。",
  loadingTitle: "分析緊你嘅餐點…",
  loadingBody: "正在辨認可見食物同估算合理份量範圍。",
  resultEyebrow: "今餐大概係",
  whyRange: "點解係一個範圍？",
  whyRangeBody:
    "KcalCue 根據相片估算食物同份量，但相片無法準確知道所有材料、重量、油份同烹調方法，所以用合理範圍會更誠實。呢個結果只供一般參考，並非醫療建議。",
  unableTitle: "無法可靠辨認",
  unableBody: "呢張相未能提供足夠線索。你可以換一張較光、由上而下、完整見到餐碟嘅相，或者手動加入食物。",
  retry: "再試一次",
  manualInput: "手動加入食物",
  useDemo: "改用示範餐",
  newMeal: "分析另一餐",
  foodBreakdown: "食物明細",
  foodBreakdownBody: "修正名稱、份量或單位，總數會即時更新。",
  uncertaintyTitle: "主要不確定因素",
  evidenceTitle: "相片分析依據",
  localNutritionNotice: "營養數值來自有來源的參考資料，不是 AI 自行估算。",
  nutritionSourceTitle: "營養資料來源",
  partialNutrition: "此總數只包括有可靠營養資料的食物。",
  insufficientNutrition: "可靠營養資料不足，顯示完整總數會誤導，所以暫不計算整餐。",
  noNutrition: "未有足夠可靠營養資料計算總數。你可以改名稱、手動選擇食物，或只參考逐項說明。",
  coarseEstimate: "辨認或份量可信程度較低，只應視為粗略估算。",
  recognitionLabel: "AI 辨認",
  nutritionLabel: "營養資料",
  nutritionIncomplete: "未完整",
  nutritionUnavailable: "未有足夠資料",
  addFood: "新增食物",
  emptyName: "未命名食物",
  deleteFood: "刪除",
} as const;

export const confidenceCopy = {
  high: "高",
  medium: "中等",
  low: "低",
} as const;

export const unitCopy = {
  g: "克 (g)",
  ml: "毫升 (ml)",
  piece: "件",
  bowl: "碗",
  cup: "杯",
} as const;

export const errorCopy: Record<string, { title: string; body: string }> = {
  missing_image: {
    title: "請先選擇相片",
    body: "影低或者選擇一張餐點相片，再開始分析。",
  },
  invalid_file: {
    title: "呢個檔案唔支援",
    body: "請選擇 JPEG、PNG、WebP、HEIC 或 HEIF 圖片。",
  },
  file_too_large: {
    title: "相片太大",
    body: "請選擇 10MB 或以下嘅圖片。",
  },
  image_read_failed: {
    title: "讀取唔到相片",
    body: "請重新選擇另一張相片。",
  },
  invalid_key: {
    title: "Live Mode 暫時未能使用",
    body: "AI 圖片分析服務嘅憑證無效。你仍可改用示範餐或手動輸入。",
  },
  model_unavailable: {
    title: "分析模型暫時不可用",
    body: "請稍後再試，或先體驗示範餐。",
  },
  network_timeout: {
    title: "分析等候時間太長",
    body: "網絡可能較慢。你可以重試，亦可以更換相片。",
  },
  rate_limited: {
    title: "暫時太多分析要求",
    body: "請稍後再試，或先體驗示範餐。",
  },
  service_unavailable: {
    title: "AI 服務暫時有問題",
    body: "你嘅相片未有保存。請稍後重試或改用示範餐。",
  },
  invalid_response: {
    title: "今次分析結果唔完整",
    body: "KcalCue 已拒絕不合規格嘅 AI 回覆。請重試或更換相片。",
  },
  image_rejected: {
    title: "AI 未能處理呢張相",
    body: "請換一張 JPEG、PNG、WebP、HEIC 或 HEIF 餐點相片；如果仍然失敗，可以試下 JPEG 或 PNG。",
  },
  unknown: {
    title: "今次未能完成分析",
    body: "相片未有保存。請重試、更換相片或手動加入食物。",
  },
};
