# Recognition labels follow their source

Manual items use a legacy numeric confidence placeholder in the saved item
shape. Rendering that value as an AI score falsely labelled manual input as
`AI 辨認：低`. Adding a manual food also lowered the whole-meal AI summary,
and renaming a recognized banana to rice retained the banana's high AI badge.
Independent browser QA reproduced all three behaviors after save, reload and
history reopen. A portion-only edit still describes the same recognized food.

The UI now matches items to immutable `analysis.foods` through the existing
stable item IDs. It uses the original AI score only while the displayed name
and identity level still match. Formatting and normalized-name language changes
do not by themselves change the displayed food identity.

- Manual input displays `手動輸入`; a renamed identity displays `已手動修正`.
- Missing original analysis displays `未有 AI 辨認資料`; demo displays `示範資料`.
- The AI summary covers only unchanged AI items and names its item count when
  part of the meal was entered or corrected manually. Manual placeholders no
  longer lower that score or cause an AI low-confidence warning.
- Nutrition confidence, calculation, portions, original analysis and persisted
  metadata are unchanged. This is a UI correction with no schema migration.

Eleven component regressions exercise real editor interactions, draft reopen,
manual addition, renamed identity, portion-only changes, demo/missing-analysis,
immutable score selection, stable IDs after reorder/delete and legacy added
items. Initial desired assertions failed on the original rendering; the
unchanged-identity control passed. The existing `originalItems` snapshot is not
treated as AI provenance because it can contain manually entered foods.

Independent mobile browser QA repeats the save/reload/history journeys against
the production build with synthetic auth/cloud/AI. These tests do not imply a
production deployment, calibrated model confidence or completion of the real
photo R2b acceptance matrix.
