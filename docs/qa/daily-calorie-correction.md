# Daily Tracking: whole-meal calorie correction

Users can enter the calories for one whole meal, then save, reload, edit or clear that value. Today and History show each meal's calories and use the same final values in the daily total. The original analysis and item nutrition references are preserved.

## Data and display contract

- `calorieCorrection: { kcal, source: "user" } | null` is separate from `analysis`, `originalItems` and editable food items. The server assigns the source. Calories are integers from 0 to 20,000; the upper bound is an input guard, not a dietary target.
- Zero is a deliberate user value. Empty, invalid or unknown values are not zero. Raw input is kept in the local draft as `calorieInput`, including an unfinished empty field, but never sent to the meal API or saved as part of a cloud record. Invalid inputs block Save.
- An explicit object sets the correction; null clears it. A legacy command that omits the field preserves the previous correction only if the food content is unchanged. Food names, identity, portions, units, preparation, ingredients and added/deleted items define that content, matched by stable IDs. Order and asynchronous nutrition metadata do not.
- Changing food content clears the draft correction and asks the user to confirm it again. Date/time/meal-type changes preserve it. Restoring original items clears it. Copying a conflict to a new meal can retain its user-entered calories, while the metadata feature clears the original creation time and schema stamp.
- Pending jobs retain their original mutation IDs and omission semantics. Their visible overlay follows the same preserve/clear rule, including multiple queued edits. A later edit returning to an earlier food content cannot resurrect a correction already cleared by an intervening queued edit.

Final calories are derived, not stored as a second total. A user value replaces that meal's reference calories; it is not added on top. All-manual totals retain their integer values. Totals containing reference estimates retain an outward-rounded range. Incomplete reference meals are labelled as partial, and unknown meals remain visibly unaccounted for. Demo meals are excluded.

Protein, carbohydrate and fat still come only from their existing nutrition references and coverage. A user-entered calorie value does not create macros or improve nutrition coverage. Per-food breakdowns remain reference estimates, not invented allocations of the whole-meal value.

Malformed stored corrections fail closed to unknown. Result, card and daily views must agree. The editor requires explicit replacement or restoration to reference estimates before saving malformed stored metadata; simply opening it must not relabel it as valid user input.

## Schema and rollout

The envelope is now schema v2. The new writer accepts missing/0/1/2 versions and rejects unknown versions, including a second check inside the transaction. Existing records upgrade only on a valid write. Reads do not migrate records. Original analysis, creation time, optimistic concurrency, idempotent acknowledgements, tombstones and UID ownership keep their existing rules.

The metadata v1 writer rejects v2 records rather than silently stripping this new correction. Every active writer and rollback build still needs the metadata-preserving floor described in [meal metadata](meal-record-metadata.md). A rollback that must continue editing v2 records needs this correction support as well. Do not route traffic to pre-metadata writers. No production migration, configuration, merge or deployment is part of this PR.

## Verification and known boundaries

The automated suite covers schema bounds/source handling, zero/unknown/partial totals, unchanged macros, legacy commands, queued edit chains, correction clearing, metadata preservation, conflicts and account ownership. The local Firestore emulator passed 28 transaction/rules cases, including v1 upgrade and correction edits/retries.

Mobile Chromium E2E covers unknown-food manual 650, persistence, reload, Today/History/edit, unfinished empty input across reload with Save blocked, explicit zero, clear back to unknown, and delete. Existing offline, conflict, retry and photo-privacy journeys remain in the suite. These tests intercept auth/cloud; they do not establish production acceptance.

Independent review found a malformed-correction inconsistency: the result hero fell back to reference calories while cards/day totals showed unknown. The fix blocks that fallback and blocks saving malformed stored source/value metadata without user action. Regression tests preserve valid reference macros and breakdowns. An initial browser-test failure was a selector matching both the form alert and Next.js's route announcer; the scoped alert assertion now passes without changing product behavior.

Final full-suite, independent browser and exact-head CI results are recorded in the PR. Real production R2b acceptance predates this feature; the new correction flow requires acceptance after an authorized release.

Cloud photo retention remains unchanged: source photos are draft-only and removed on save. This PR does not enable a Storage bucket or promise persistent history photos. It also does not add per-food manual macros, coaching, budgets or an analysis receipt system.
