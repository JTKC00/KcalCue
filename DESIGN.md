---
name: KcalCue
description: "影低你嘅一餐，快速了解大概卡路里同主要營養素範圍。"
colors:
  sign: "#c62a1f"
  sign-deep: "#9f1f16"
  sign-tint: "#ffe2dc"
  yolk: "#ffd23f"
  yolk-soft: "#fff1b8"
  keep: "#2e7d32"
  keep-deep: "#1f5f24"
  steel: "#e6e9eb"
  steel-2: "#d5dade"
  steel-3: "#b3bac0"
  steel-4: "#8a9198"
  foam: "#fcfcfa"
  white: "#ffffff"
  ink: "#1e1b18"
  ink-2: "#4c4741"
  ink-3: "#635d56"
typography:
  display:
    fontFamily: "'Barlow Condensed', 'DIN Condensed', 'Bahnschrift', 'Roboto Condensed', 'Arial Narrow', -apple-system, 'PingFang HK', 'Noto Sans HK', sans-serif"
    fontSize: "3.75rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "-0.005em"
    fontFeature: "'tnum', 'lnum'"
  wordmark:
    fontFamily: "'Barlow Condensed', 'DIN Condensed', 'Bahnschrift', 'Roboto Condensed', 'Arial Narrow', -apple-system, 'PingFang HK', 'Noto Sans HK', sans-serif"
    fontSize: "2rem"
    fontWeight: 700
    lineHeight: 1
    letterSpacing: "0.005em"
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang HK', 'Noto Sans HK', 'Noto Sans CJK TC', 'Microsoft JhengHei', 'Segoe UI', sans-serif"
    fontSize: "1.75rem"
    fontWeight: 700
    lineHeight: 1.25
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang HK', 'Noto Sans HK', 'Noto Sans CJK TC', 'Microsoft JhengHei', 'Segoe UI', sans-serif"
    fontSize: "1.25rem"
    fontWeight: 700
    lineHeight: 1.25
  placard-name:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang HK', 'Noto Sans HK', 'Noto Sans CJK TC', 'Microsoft JhengHei', 'Segoe UI', sans-serif"
    fontSize: "1.375rem"
    fontWeight: 700
    lineHeight: 1.25
  figure:
    fontFamily: "'Barlow Condensed', 'DIN Condensed', 'Bahnschrift', 'Roboto Condensed', 'Arial Narrow', -apple-system, 'PingFang HK', 'Noto Sans HK', sans-serif"
    fontSize: "1.5rem"
    fontWeight: 700
    lineHeight: 1.1
  figure-sm:
    fontFamily: "'Barlow Condensed', 'DIN Condensed', 'Bahnschrift', 'Roboto Condensed', 'Arial Narrow', -apple-system, 'PingFang HK', 'Noto Sans HK', sans-serif"
    fontSize: "1.1875rem"
    fontWeight: 700
  numeric-meta:
    fontFamily: "'Barlow Condensed', 'DIN Condensed', 'Bahnschrift', 'Roboto Condensed', 'Arial Narrow', -apple-system, 'PingFang HK', 'Noto Sans HK', sans-serif"
    fontSize: "1.0625rem"
    fontWeight: 600
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang HK', 'Noto Sans HK', 'Noto Sans CJK TC', 'Microsoft JhengHei', 'Segoe UI', sans-serif"
    fontSize: "1rem"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang HK', 'Noto Sans HK', 'Noto Sans CJK TC', 'Microsoft JhengHei', 'Segoe UI', sans-serif"
    fontSize: "0.8125rem"
    fontWeight: 700
  label-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang HK', 'Noto Sans HK', 'Noto Sans CJK TC', 'Microsoft JhengHei', 'Segoe UI', sans-serif"
    fontSize: "0.75rem"
    fontWeight: 700
  button:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'PingFang HK', 'Noto Sans HK', 'Noto Sans CJK TC', 'Microsoft JhengHei', 'Segoe UI', sans-serif"
    fontSize: "0.9375rem"
    fontWeight: 700
    lineHeight: 1.2
rounded:
  rail: "2px"
  radius-sm: "3px"
  radius: "4px"
  circle: "50%"
spacing:
  hair: "2px"
  tight: "4px"
  chip: "6px"
  module: "8px"
  cell: "10px"
  inset: "12px"
  card: "16px"
  gutter: "16px"
  content: "880px"
  nav-height: "63px"
components:
  button-primary:
    backgroundColor: "{colors.sign}"
    textColor: "{colors.white}"
    typography: "{typography.button}"
    rounded: "{rounded.radius}"
    padding: "0 18px"
    height: "48px"
  button-primary-hover:
    backgroundColor: "{colors.sign-deep}"
  button-secondary:
    backgroundColor: "{colors.foam}"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.radius}"
    padding: "0 18px"
    height: "48px"
  button-secondary-hover:
    backgroundColor: "{colors.white}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.button}"
    rounded: "{rounded.radius}"
    padding: "0 18px"
    height: "48px"
  button-ghost-hover:
    backgroundColor: "{colors.steel-2}"
  button-save:
    backgroundColor: "{colors.keep}"
    textColor: "{colors.white}"
    typography: "{typography.button}"
    rounded: "{rounded.radius}"
    height: "52px"
  button-save-hover:
    backgroundColor: "{colors.keep-deep}"
  button-disabled:
    backgroundColor: "{colors.steel-2}"
    textColor: "{colors.ink-3}"
  quick-action-ai:
    backgroundColor: "{colors.sign}"
    textColor: "{colors.white}"
    rounded: "{rounded.radius}"
    padding: "8px 12px"
    height: "60px"
  input-field:
    backgroundColor: "{colors.white}"
    textColor: "{colors.ink}"
    typography: "{typography.body}"
    rounded: "{rounded.radius-sm}"
    padding: "10px 12px"
    height: "48px"
  price-board:
    backgroundColor: "{colors.yolk}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius}"
    padding: "12px 14px"
  price-board-macro:
    backgroundColor: "{colors.yolk-soft}"
    textColor: "{colors.ink}"
    padding: "8px 12px 10px"
  meal-tray:
    backgroundColor: "{colors.steel-2}"
    textColor: "{colors.ink}"
    padding: "10px"
  placard:
    backgroundColor: "{colors.foam}"
    textColor: "{colors.ink}"
    typography: "{typography.placard-name}"
    rounded: "{rounded.radius-sm}"
    padding: "8px 10px 9px"
  food-placard-draft:
    backgroundColor: "{colors.foam}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius-sm}"
    padding: "12px"
  kcal-tag:
    backgroundColor: "{colors.yolk}"
    textColor: "{colors.ink}"
    rounded: "{rounded.radius-sm}"
    padding: "1px 10px"
  chip-ai-draft:
    backgroundColor: "{colors.foam}"
    textColor: "{colors.sign}"
    typography: "{typography.label}"
    rounded: "{rounded.radius-sm}"
    padding: "3px 10px"
  chip-saved:
    textColor: "{colors.keep}"
    typography: "{typography.label-sm}"
    rounded: "{rounded.radius-sm}"
    padding: "0 6px"
  count-tag:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.yolk}"
    rounded: "{rounded.radius-sm}"
    padding: "1px 10px"
  signboard-band:
    backgroundColor: "{colors.sign}"
    textColor: "{colors.white}"
    height: "64px"
  status-strip:
    backgroundColor: "{colors.ink}"
    textColor: "#f2f0ea"
    height: "30px"
  save-bar:
    backgroundColor: "{colors.foam}"
    rounded: "{rounded.radius}"
    padding: "10px"
  nav-bar:
    backgroundColor: "{colors.foam}"
    textColor: "{colors.ink-3}"
    typography: "{typography.label-sm}"
    height: "60px"
  nav-bar-current:
    textColor: "{colors.ink}"
  nav-camera:
    backgroundColor: "{colors.sign}"
    textColor: "{colors.white}"
    rounded: "{rounded.circle}"
    size: "74px"
  nav-camera-hover:
    backgroundColor: "{colors.sign-deep}"
---

# Design System: KcalCue

## Overview

**Creative North Star: "兩餸飯餸牌: The Two-Dish Rice Counter"**

Every meal is a tray of picked dishes, laid out the way a Hong Kong two-dish-rice (兩餸飯) shop shows its food: a signboard-red band overhead, a stainless counter below, each dish on its own ink-framed placard, and the total written up on a yolk price board. The AI lays the dishes out as placards, the eater checks each one, and the honest range sits on the board. Surfaces are printed, not glassy: heavy ink frames, near-square corners, condensed numerals readable across a café table, and no shadow anywhere.

Density is counter-dense rather than dashboard-dense. Placards pack edge to edge in their trays, totals are large and drawn to scale, and everything else stays quiet foam and steel. State is carried by form before colour: a dashed line is a draft still to be checked, a solid line is saved, a 45° ink hatch is unknown, and an empty slot is a dashed grey outline. Each colour has one job: red is the shop's sign and its main action, yolk carries the headline total, green belongs only to saving.

AI photo recognition is the primary entry and wears the red; manual logging sits beside it in foam, secondary but always available. The world refuses the calorie-app default: no calorie ring counting down a goal, no pastel macro donuts, no cream-and-sage wellness cards. It replaces the warm-white, deep-green and coral palette that DECISIONS.md §9 still describes; that section's fixed result order still binds.

Open decisions: the app icon (public/icon.svg and its PNG versions, a deep-green #173f35 tile with cream and orange) predates this world and has not been confirmed by James, so it was deliberately left untouched and stays that way until he chooses keep or redraw. The subtitle lines under headings stay as written until James decides whether to remove them.

**Key Characteristics:**
- Signboard-red band and primary action over a stainless-steel ground.
- Foam-white placards in 2–3px ink frames with 3–4px corners.
- Yolk price boards with range rails drawn from 0 to at least 1500 kcal.
- Barlow Condensed for figures; the system Hei stack for names and sentences.
- State by form: dashed is draft, solid is saved, hatched is unknown.
- Green only for save and saved; no shadows anywhere.

## Colors

A shopfront palette: one loud signboard red, one yolk board, one reserved green, on a cool stainless-and-ink ground.

### Primary
- **Signboard Red** (#c62a1f): The header band, the main action of each group (AI 相片辨識, 影相分析, 用相片 AI 辨識, retry), the raised camera tab, the current-tab bar, the analysis scan line, alert and invalid frames, error text, and the dashed AI 起草 chip. Also the browser theme colour. It frames and acts; it is never a reading surface.
- **Roast Red** (#9f1f16): Hover and current states of every red control; destructive text (刪除, the delete icon) and the invalid-correction alert on the meal board.
- **Signboard Tint** (#ffe2dc): Small secondary text set on red (sublabels such as 相片起草) and the disabled account button.

### Secondary
- **Yolk** (#ffd23f): The price boards, the KcalCue wordmark on red, text selection, the per-dish kcal tag in the editor, yolk-on-ink numerals (item count, dish index, principle pill, demo chip), the syncing status dot and the photo status badge.
- **Soft Yolk** (#fff1b8): The macro cells under each price board, provisional notices (coverage, inline warnings, mode banner, demo note) and hover on choice controls.

### Tertiary
- **Keep Green** (#2e7d32): The save action (儲存餐點 in the save bar) and the 已保存 chip. Nothing else.
- **Keep Green Deep** (#1f5f24): Hover on the save action.

The synced dot on the ink status strip is Keep Green as well, inside a paper-white ring; the dot itself reaches 3.3:1 against ink, above the 3:1 floor for graphics, and the ring carries it further.

### Neutral
- **Stainless Counter** (#e6e9eb): The page ground, the installed-app background, disabled fields and the scrollbar track.
- **Tray Steel** (#d5dade): Tray strips under placards (meal rows, the editor's food list), ghost-button hover, disabled buttons and the analysis photo well.
- **Brushed Steel** (#b3bac0): Tray edges, hairlines between list rows and disabled button frames.
- **Rivet Grey** (#8a9198): Dashed outlines of empty slots, disabled field frames, the data-source hairline and the scrollbar thumb. Lines only, never text (2.6:1 on the counter).
- **Foam White** (#fcfcfa): Placards, cards, resting buttons, chips, notices, the save bar and the bottom nav.
- **White** (#ffffff): Text fields, the hover lift of foam controls, and text on red and green.
- **Counter Ink** (#1e1b18): Every frame and rule, primary text, the rail fill, the hatch, the status strip and the focus outline.
- **Ink 2** (#4c4741): Secondary text, rail ticks, times and dates.
- **Ink 3** (#635d56): Tertiary text, placeholders, resting nav labels and subtitle lines.

### Named Rules
**The Keep-Green Rule.** Green belongs only to saving and saved: the 儲存餐點 button, the 已保存 chip and the synced dot. A screen with nothing saved or being saved shows no green.

**The Signboard Rule.** Red is the shop's sign and the one main action per group. It frames and acts (band, primary buttons, camera tab, current tab, error frames); it never becomes a reading surface.

**The Price-Board Rule.** A screen's headline total (the day on Today and History, the meal on the result screen) sits on a Yolk board in Counter Ink, with its range rail and its macros on Soft Yolk beneath. Per-meal and per-dish ranges stay small on their trays and placards.

## Typography

**Display Font:** Barlow Condensed 600/700, self-hosted woff2 limited to Latin (falling back to DIN Condensed, Bahnschrift, Roboto Condensed, Arial Narrow, then PingFang HK / Noto Sans HK for any Chinese inside a figure)
**Body Font:** the system Hei stack (-apple-system, BlinkMacSystemFont, PingFang HK, Noto Sans HK, Noto Sans CJK TC, Microsoft JhengHei, Segoe UI, sans-serif)

**Character:** Price-board numerals against shop-sign Chinese: a tall condensed grotesque for everything read as a number, and the platform's own Hei, set heavy for dish names, for everything read as language.

### Hierarchy
- **Display** (Barlow Condensed 700; 60px on the day board, 52px there below 375px; 56px on the meal board; line-height 1; -0.005em; tabular lining figures): The price-board total only.
- **Wordmark** (Barlow Condensed 700, 32px, line-height 1, 0.005em): KcalCue in Yolk on the red band.
- **Headline** (Hei 700, 28px, line-height 1.25): Screen titles (今日飲食, 歷史記錄, 記低新一餐); 24px for the editor title; 22px for analysing, recovery and the photo hero.
- **Title** (Hei 700, 20px, line-height 1.25): Section and day headings (食物明細, 主要不確定因素, History dates); 18px for card headings; 17px for tray titles (早餐, 午餐, 晚餐, 小食) over a 3px ink rule.
- **Placard Name** (Hei 700, 22px, line-height 1.25, breaks anywhere): Dish names on placards and in the dish-name field.
- **Figure** (Barlow Condensed 700, 24px, line-height 1.1): Macro values, the meal count and the meal-board figure line; the day board's kcal unit is 22px in 600 and the editor's kcal tag 22px in 700.
- **Placard Figure** (Barlow Condensed 700, 19px): Kcal ranges on placards and in tray meta lines.
- **Numeric Meta** (Barlow Condensed 600, 17px): Times and the Today date (16px for History day stamps); 13px for rail ticks; 18px inside date, time and number fields (20px for portions).
- **Body** (Hei 400, 16px, line-height 1.55): Running text; 15px in Ink 2 for secondary copy inside cards.
- **Label** (Hei 700, 13px): Board and cell labels, chip text and form labels.
- **Small Label** (Hei 700, 12px): Field captions, nav labels and small tags (已保存, 備註).
- **Button** (Hei 700, 15px, line-height 1.2): Button labels; 16px in the save bar and quick actions, 17px on large buttons.

Subtitle lines: the former eyebrow lines now sit 2px below their headings as subtitles (13px, 600, Ink 3), text unchanged, by James's decision. They are carried copy, not a type role for new surfaces; whether they stay is James's open copy decision.

### Named Rules
**The Figures-In-Barlow Rule.** A number that stands as a value (kcal, grams, counts, times, dates, ticks, numeric inputs) is set in Barlow Condensed; a number inside a Chinese sentence stays in Hei with its sentence.

## Layout

One centred column, at most 880px wide, with a 16px gutter (12px at 520px and below, 24px from 761px). The red band and the ink status strip run full-bleed and align their contents to the same column. Sections stack 16px apart (20px from 761px), starting 18px under the strip (24px from 761px). The bottom nav is fixed; the shell reserves its 63px height plus 40px and the safe area so nothing ends up under it.

Spacing runs in small even steps (2, 4, 6, 8, 10, 12, 14, 16px) around an 8px module: 8px separates placards and the buttons in a group and pads the editor's tray strip, 10–12px set the insides of rows and cards, 16px pads cards and separates sections. Touch targets never fall below 44px.

Today reads top to bottom: band, status strip, the title with the date on its baseline, the day price board, the entry pair (AI 相片辨識 at 1.3fr beside 手動記餐 at 1fr), then one tray per meal: 早餐, 午餐, 晚餐, 小食. From 900px the board and the entry pair span the full width (the pair becomes two equal columns) and the four trays form a 2×2 wall whose rows stretch to equal height. History shows the entry pair and a date filter, then one board per day with its meals; from 900px the meal rows pair up in two columns.

The result screen keeps the order fixed by DECISIONS.md §9: kcal range → confidence → breakdown → uncertainty → correction controls. On phones the first view holds the price board, the macros, the confidence panel and the 食物明細 heading; the dishes arrive after one short scroll, as James accepted: 「接受：捲一下先見到食物（建議）」. From 1000px the result splits into the main column and a 272px sticky sidebar (photo, mode note, privacy, data source). The editor continues below the result with time and meal, the whole-meal kcal correction, the note, the draft actions and the save bar.

Breakpoints: 374px and below (the date takes its own row, the day-board figure drops to 52px), 520px and below (12px gutter, 14px card padding, tagline hidden, entry cards stack), 760px and below (meal metadata in two columns), from 761px (24px gutter), from 900px (the tray wall), from 1000px (the result sidebar). Food placards also answer a container query at 420px.

### Named Rules
**The Edge-to-Edge Rule.** Placards pack edge to edge: auto-fit columns with an 8px gap, at least 144px wide in trays and 272px in the food editor, so a tray fills its width however many dishes it holds.

**The One-Scale Rule.** Every kcal range is drawn to scale on a rail that starts at 0 and reaches at least 1500 kcal, so ordinary meals and days share one scale. A range that runs past 1500 extends its own rail to the next 500 kcal (ticks every 500 up to 2000, then every 1000).

## Elevation & Depth

The system is flat and nothing casts a shadow. Depth comes from three things: tonal steps in the ground (Stainless Counter, then Tray Steel strips, then Foam White placards), the weight of ink frames (2px for placards and fields, 3px for boards, the save bar and the nav's top rule), and one overlap: the camera tab, a red circle in a 3px ink ring that rises 28px above the nav's rule. Sticky elements (the save bar, the bottom nav, the result sidebar) are separated by their frames, not by shadow.

### Ring Vocabulary
- **Alert ring** (`box-shadow: inset 0 0 0 1px var(--sign)`): Doubles the 2px red frame of alert notices and invalid fields.
- **Status dot ring** (`box-shadow: 0 0 0 2px var(--ink), 0 0 0 3.5px #f2f0ea`): Lifts the 9px status dot off the ink strip; offline replaces the fill with a hollow `inset 0 0 0 2px #f2f0ea` ring.

### Named Rules
**The No-Shadow Rule.** No drop shadows, glows, blurs or offset shadows, at rest or on hover. box-shadow appears only as a zero-offset, zero-blur ring that thickens a frame or rings the status dot.

## Shapes

Printed signage geometry: near-square corners, heavy ink frames, flat fills.

- **Corners:** 3px for placards, chips, fields, tags and icon tiles; 4px for cards, buttons, boards, notices and the save bar; 2px on the range rail. Circles only for the status dots, the camera tab and the camera badge in the lunch-box illustration (the illustration's box alone takes 6px).
- **Frames:** 2px Counter Ink by default; 3px for price boards, the entry buttons, the upload, loading and recovery cards, the save bar, tray-title and section-heading rules, and the nav's top rule; 1.5px on small tags and hatch swatches; 1px Brushed Steel for tray edges and row separators.
- **Hatch:** unknown is a 45° ink hatch (1.5px lines every 5px). Inline it is a 20×10px swatch in a 1.5px ink frame; an unknown total turns its whole rail into hatch.
- **Disclosure:** chevrons are two 2px borders turning from -45° to 45° as the section opens (180ms).
- **Icons:** 24-unit line icons, 1.8 stroke, round caps and joins; 20px in buttons, 22px in the nav, 26px in the camera tab. Icon tiles are 32–38px squares in a 2px frame with 3px corners.

### Named Rules
**The Form-Is-State Rule.** State is carried by form before colour. Dashed Counter Ink marks a draft or an AI-origin item still to be checked: food placards in the editor, the unsaved-draft banner, the AI 分析結果 chip, original-AI details, low-confidence badges and panels, provisional Soft Yolk notices and the 新增食物 slot (the editor's AI 起草 chip draws the same dash in Signboard Red). Solid ink is the resting frame: saved placards and trays on Today and History, and the interface's own boards, cards, fields and buttons. The ink hatch marks unknown or insufficient data. Dashed Rivet Grey marks an empty slot.

## Components

Every component belongs to the counter: flat fills, ink frames, heavy Hei labels.

### Buttons
Printed tickets: flat fill, thick ink frame, heavy label.
- **Shape:** 4px corners, 2px Counter Ink frame; 48px minimum height (44px inside rows and notices, 52px in the save bar, 56px large, 60px quick actions).
- **Primary:** Signboard Red fill, White 15px/700 Hei label, 0 18px padding; a 20px icon 8px from the label.
- **Hover / Focus:** red darkens to Roast Red, Foam lifts to White, ghosts take Tray Steel; a press nudges 1px down (150ms, cubic-bezier(0.16, 1, 0.3, 1)). Focus is a 3px Counter Ink outline 2px out (Yolk on the red band).
- **Secondary:** the default button: Foam White fill, ink frame and label.
- **Ghost:** transparent frame and fill; danger ghosts (刪除) use Roast Red text.
- **Save:** Keep Green with a White label, only inside the save bar; hover Keep Green Deep.
- **Disabled:** Tray Steel fill, Brushed Steel frame, Ink 3 label.
- **Entry pair:** AI 相片辨識 (Signboard Red, 1.3fr) beside 手動記餐 (Foam, 1fr): 60px, 3px frame, a 32px framed icon tile, a 16px label over a 12px sublabel. On 記低新一餐 the pair grows into 92px entry cards, the AI card red.
- **新增食物:** full width, 56px, dashed ink frame, no fill.
- **Icon button:** 44px square, transparent; hover shows an ink frame on White.

### Chips
Square tags stamped on the counter.
- **Style:** 3px corners, 2px frame (1.5px on small tags), 12–13px Hei 700.
- **Mode chips:** AI 起草 in the editor is dashed Signboard Red on Foam, 手動記錄 solid ink. On the meal board, AI 分析結果 is dashed ink on Foam, 手動輸入 solid, 示範結果 Counter Ink with Yolk text.
- **已保存:** Keep Green frame and text on a Foam White fill (4.9:1), on History rows.
- **Badges:** recognition and nutrition badges are 1.5px ink on Foam, dashed when confidence is low.
- **Count tags:** Counter Ink with Yolk Barlow numerals (2 項, the dish index).

### Cards / Containers
- **Corner Style:** 4px.
- **Background:** Foam White; provisional notices Soft Yolk.
- **Shadow Strategy:** none (see Elevation & Depth).
- **Border:** 2px Counter Ink; 3px for the upload, loading and recovery cards; dashed for the unsaved-draft banner and provisional notices; dashed Rivet Grey with no fill for empty states; Signboard Red plus the alert ring for alerts.
- **Internal Padding:** 16px (14px at 520px and below), 10px between children.

### Inputs / Fields
- **Style:** White fill, 2px Counter Ink frame, 3px corners, 48px minimum height, 10px 12px padding, 16px Hei. Date, time and number fields switch to Barlow 600 at 18px (20px for portions, 24px/700 for the whole-meal kcal). Selects carry a drawn ink chevron.
- **Dish name:** frameless over a 2px dashed ink underline (a draft to check), 22px/700; hover White; focus closes it into a full 2px ink frame on White.
- **Focus:** the global 3px Counter Ink outline.
- **Error / Disabled:** invalid fields take a Signboard Red frame plus the alert ring and a 12–13px/700 red message; disabled fields turn Stainless Counter with a Rivet Grey frame and Ink 3 text.
- **Portion presets (少／普通／多):** three equal Foam cells in one 2px ink frame divided by 2px ink rules; hover Soft Yolk; disabled Stainless Counter.

### Navigation
- **Signboard band:** full-bleed Signboard Red, 64px; the KcalCue wordmark in Yolk, the 每日飲食小記 tagline in White 13px (hidden at 520px and below); 帳戶 is an outline button with an 85% white frame that fills Roast Red on hover.
- **Status strip:** Counter Ink, 30px, 12px/600 Hei in paper white (#f2f0ea, a literal). The 9px dot is Yolk while connecting, the lighter synced green once synced, and a hollow ring offline; the words always state the status as well.
- **Bottom nav:** a fixed Foam bar under a 3px ink rule, columns 1fr / 96px / 1fr (content capped at 560px), 60px buttons with 12px/700 labels in Ink 3. The current tab turns ink over a 28×4px Signboard Red bar. The centre 新增 is a 74px Signboard Red circle in a 3px ink ring, raised 28px over the rule, with a 26px camera; hover and current go Roast Red. Disabled items drop to 55% opacity.

### Price Board
The signature surface: the shop's price board, one per screen.
- **Board:** Yolk fill, 3px Counter Ink frame, 4px corners. The board label sits top-left (13px/700: 卡路里, 已知部分卡路里, 今餐大概係, 本餐卡路里); 「今餐大概係」 and 「本餐卡路里」 are the board's header label, not eyebrows. The meal count (今日餐數 2 餐) or the mode chip sits top-right.
- **Total:** Display Barlow; the day board sets its kcal unit in Barlow 600 at 22px, the meal board prefixes 約 and adds 中間估算 under the rail. Unknown totals switch to Hei (32px 未知 or 未記錄; 28px 暫未能計算 on the meal board) over a hatched rail.
- **Rail:** a 12px track in Counter Ink at 16% opacity with an ink fill at the true position (at least 4px wide) and Barlow 600 13px ticks in Ink 2.
- **Macros:** three equal Soft Yolk cells under a 3px ink rule, divided by 2px ink rules: label, 24px Barlow value, unit.
- **Gap notes:** full-width rows under a 2px ink rule, each led by a hatch swatch.

### Meal Trays and Placards
- **Tray:** the title (早餐, 午餐, 晚餐, 小食) in Hei 17px/700 over a 3px ink rule; below it a Tray Steel strip with Brushed Steel edges and 10px padding. Meals in one tray are divided by 2px Rivet Grey rules (3px ink rules in History, where rows stand apart).
- **Meta line:** time · meal in Barlow 600 17px Ink 2, the 已保存 chip in History, and the meal's kcal right-aligned in Barlow 700 19px. An unknown meal kcal drops to a hatch swatch and a 13px Hei line.
- **Placards:** Foam White, 2px solid ink, 3px corners, at least 66px tall, 8px 10px 9px padding; the dish name in Hei 22px/700 over its range in Barlow 19px/700 (約 x–y kcal). Unknown shows a hatch swatch and 未有足夠資料; a meal saved with a whole-meal manual kcal shows names only.
- **Empty tray:** a dashed Rivet Grey outline reading 未有記錄.
- **Note and actions:** a 備註 tag (1.5px ink on Foam) leads the note; 查看／修正 (secondary, 44px) and 刪除 (danger ghost) close the row.

### Food Editor Placards
- **Placard:** dashed 2px ink on Foam, 3px corners, 12px padding, laid on a Tray Steel strip (8px padding) in auto-fit 272px columns with 8px gaps.
- **Head:** a 36px Counter Ink index tile with a Yolk Barlow numeral, the 食物名稱 caption over the dashed-underline name field, and a Roast Red delete icon button.
- **Summary:** a Yolk kcal tag (2px ink frame, Barlow 22px) followed by the recognition and nutrition badges.
- **Controls:** 少／普通／多 presets, min 至 max portion fields and the unit select; once the placard is 420px wide the portion fields share one row. Warnings use the dashed Soft Yolk notice.
- **Entrance:** placards rise 10px into place over 280ms (cubic-bezier(0.16, 1, 0.3, 1)), staggered 45ms each up to 180ms; reduced motion removes it.

### Save Bar
- **Bar:** Foam, 3px ink frame, 4px corners, 10px padding; 放棄修改 (secondary) and 儲存餐點 (Keep Green) share the width at 52px. AI drafts add a 12px Ink 2 review note above the buttons.
- **Behaviour:** sticky 10px above the bottom nav (plus the safe area) only while the draft has foods; with no foods it sits static in the flow.

### Photo, Analysis and Recovery
- **Upload card:** 3px ink frame; a lunch-box illustration (White box, rice in Stainless Counter, one Yolk and one Signboard Red dish, ink frames, a circular camera badge); 影相分析 (primary, large) beside 選擇相片.
- **Selected photo:** a 3px ink frame with a Yolk status badge top-left and file details in Barlow tags.
- **Analysing:** the photo in a 2px frame with a 5px Signboard Red scan line (ink edges) sweeping down and back every 1.8s; the active step in ink 700, the others Ink 2.
- **Recovery:** a red-framed icon tile; the primary retry spans both columns above the other choices.

### Structural Hooks
Tests rely on these hooks; every restyle keeps them, along with every aria-label and accessible name: `.meal-row`, `.meal-calories`, `.day-summary > div` (the kcal cell holds exactly one `strong`), `.food-card`, `.metadata-grid`, `.meal-metadata`, `.meal-journal-note`, `.journal-notice`, `#result-title span`, `.journal-nav-add`, `.journal-hero-card`, `.journal-title-actions`.

## Do's and Don'ts

### Do:
- **Do** carry state by form: dashed ink for drafts and AI-origin items, solid ink once saved, the 45° ink hatch for unknown or insufficient data, dashed Rivet Grey for empty slots.
- **Do** lead entry points with the AI photo action in Signboard Red and keep a Foam White manual option on the same surface.
- **Do** set figures that stand as values in Barlow Condensed (700 for amounts, 600 for times, dates and ticks) and names and sentences in the Hei stack.
- **Do** draw every kcal range to scale on a rail from 0 to at least 1500 kcal, ink fill at its true position, hatched when the total is unknown.
- **Do** frame placards, cards, fields and buttons in Counter Ink (2px; 3px for boards, entry buttons, the save bar and the nav rule) with 3px or 4px corners.
- **Do** pack placards edge to edge with auto-fit columns and an 8px gap (144px minimum in trays, 272px in the food editor).
- **Do** keep the result order kcal range → confidence → breakdown → uncertainty → correction controls.
- **Do** keep the save bar sticky above the nav only while the draft has foods, static otherwise.
- **Do** keep touch targets at 44px or more and the 3px ink focus outline (Yolk on the red band).
- **Do** keep the structural hooks, aria-labels and accessible names through every restyle.

### Don't:
- **Don't** use green for anything but saving and saved.
- **Don't** add drop shadows, glows or blur for depth; separate with frames, tone and overlap.
- **Don't** show an unknown as zero, a blank or an empty rail; hatch it and say so.
- **Don't** reach for the calorie-app default: no calorie ring counting down a goal, no pastel macro donuts, no cream-and-sage wellness cards.
- **Don't** change UI copy without James's approval; a restyle keeps every string.
- **Don't** add new subtitle lines under headings on new surfaces; the existing ones are carried copy awaiting James's decision.
- **Don't** round frames past 4px; circles are only for dots and the camera.
- **Don't** let Signboard Red fill a reading surface.
- **Don't** recolour, redraw or replace the app icon (public/icon.svg and its PNGs) until James confirms keep or redraw.
