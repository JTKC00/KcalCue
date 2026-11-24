---
version: 1
slug: "src-app-page-tsx"
primary_target: "src/app/page.tsx"
related_targets: ["src/components/meal-journal.tsx","src/components/kcalcue-app.tsx","src/components/result-view.tsx","src/components/food-editor.tsx","src/components/image-input.tsx","src/app/globals.css"]
---

## Scope

Whole journal app at `/` (Operate): Today, New/Edit (photo input, analyzing, recovery, result, food editor, note, manual kcal, save tray), History, Account & install. Mobile-first (375×812), desktop 1280×900 must hold.

## Audience, job, constraints

Hong Kong eater logging a meal one-handed, often under fluorescent café light. Job: snap → check AI's dishes item by item → save; glance at the day's range. AI photo is the primary entry (James, 2026-11-23); manual stays one tap away. Copy is unchanged; eyebrow lines move below their headings, text intact (James, 2026-11-23). Keep test-relied hooks: `.meal-row`, `.meal-calories`, `.day-summary > div` + `strong`, `.food-card`, `.metadata-grid`, `.meal-metadata`, `.meal-journal-note`, `.journal-notice`, `#result-title span`, `.journal-nav-add`, `.journal-hero-card`, `.journal-title-actions`, aria-labels and accessible names.

## Direction contract

THESIS: Every meal is a tray of picked dishes. AI lays the dishes out as placards; the eater checks each one, and the honest range sits on the price board. It refuses the category default: a calorie ring counting down a goal, pastel macro donuts, cream-and-sage wellness cards.

OWN-WORLD: Signboard-red #C62A1F header band with yolk #FFD23F wordmark; stainless #E6E9EB ground, tray strips #D2D7DA; foam-white #FCFCFA placards in 2–3px ink #1E1B18 frames, 3–4px corners, no shadows; yolk price boards for totals; Barlow Condensed 600/700 (self-hosted) for every numeral, heaviest system Hei for names. Green #2E7D32 belongs only to save and saved. State is form: dashed = draft, solid = saved, hatched = unknown. Ranges drawn to one shared scale; one 8px module; placards pack edge to edge.

STORY: They snap the meal, see the AI's dishes as placards with ranges, nudge 少／普通／多, save. Today reads as the day's price board plus one tray per meal. They trust the range because unknowns stay visibly hatched, never zero.

FIRST VIEWPORT: Today at 375: red signboard (KcalCue left, 帳戶 right), ink sync strip, 今日飲食 + date, yolk price board (day range in ~60px Barlow numerals, to-scale bar on a 0–1500 kcal rail, three macro cells, hatched unknown note), red AI 相片辨識 (wide) beside white ＋ 手動記餐, then the 早餐 tray of placards. Bottom tab bar, raised red camera 新增 at centre.

FORM: 兩餸飯餸牌, my resonance list position 5 of 7, seed:aeb6fc67c7c53f73.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Memorable moment

The result screen: the AI's dishes arrive as a wall of placards, each with its own range, totalled on a yellow price board.

## Unresolved

- App icon (`public/icon.svg`): untouched in this build; redrawn on 2026-11-24 as the hanging price board (see DESIGN.md).
- Eyebrow lines kept as subtitles; full removal is a later copy decision for James.
