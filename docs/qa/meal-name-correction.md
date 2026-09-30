# Meal identity correction and late-response safety

## Problem and root cause

Editing an AI dish to a known single food (for example a mistaken salad identification to banana) changed only display/normalized names. The old dish label, preparation and visible ingredients continued to drive canonical matching. Both the displayed result and the saved server result stayed unresolved. Separately, a delayed lookup for A could overwrite a newer result after editing A to B and back to A, because the callback compared only the text.

## Change

- New food names clear stale AI preparation, visible ingredients and notes in editable items. Original `analysis` and `originalItems` remain unchanged.
- A complete catalog name or alias, rather than a substring, is required to turn an original AI dish into an ingredient. Original analysis anchors the classification through progressive typing and reopening saved records; originalItems is the legacy fallback. This keeps banana salad/smoothie/split conservative while allowing an explicit banana correction. No schema migration or new client-authoritative nutrient values are introduced.
- A per-item edit revision rejects stale nutrition callbacks, including the A/B/A sequence. Whitespace/case-only edits preserve current identity metadata and existing cache rules.

## Validation

Node 24.15.0. Full lint and typecheck PASS. Unit/integration 228/228 PASS across 26 files; includes 13 new correction, server-save and callback regressions. Deterministic nutrition evaluation 47/47 PASS. Production build and Chromium E2E 6/6 PASS at 375x812; synthetic auth/cloud/AI only. The new E2E covers upload, correction, save payload, authenticated mocked GET, reload, History and editing with unchanged estimates.

Independent reviewer reproduced the UI and POST failures plus the A/B/A race on the baseline. Its final 16 adversarial tests and 65 existing scoped tests passed on this change, including progressive typing through banana and reopening a corrected record with/without analysis. An initial permissive ingredient reset failed salad/smoothie/split probes; the final implementation uses complete-name matching instead.

Firestore emulator 8/8 PASS using firebase-tools 15.29.0, Java 21 and isolated `demo-kcalcue` on localhost:8198. CI results are recorded in the PR after execution.

## Risk and limits

The fix is scoped to explicit name corrections and response freshness. A new ingredient name outside the reference catalog may remain unresolved when correcting an original dish; that conservative outcome is preferable to counting a compound food as one ingredient. It does not expand nutrition coverage or establish measured calorie accuracy.

Production currently runs a separate deployment snapshot. No merge, deployment or production configuration change is part of this PR. Live real-photo R2b evidence is tracked separately; local/mocked PASS does not establish production PASS.
