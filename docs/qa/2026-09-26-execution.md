# KcalCue R2b execution record

## Baseline and boundaries

- Date: 2026-09-26, Asia/Hong_Kong.
- Isolated branch: `codex/r2b-reliability-20260926`, base `0e77334` (current origin/main).
- Existing deployment/evaluation edits in the owner's main checkout are preserved and excluded.
- No open GitHub PRs or issues at preflight. Production status responds 200; anonymous meals request responds 401 `login_required`.
- Owner reports R2a authenticated entitlement PASS. This is supplied evidence; today's anonymous probe does not revalidate it.
- Production mutations require an explicitly identified QA identity. Never infer QA ownership from an available personal login.
- No merge or deployment authorization is inferred. Deliver narrow PRs for review.

## Execution plan

1. Locate R2a evidence, QA identity and real-image fixtures; verify production architecture read-only.
2. Run five real-photo cases (simple meal, mixed meal, drink, poor lighting/angle, ambiguous portion) through upload, analysis, correction, save, API readback, reload and history if QA authentication is available.
3. Independently review persistence/account/race correctness and reproduce any defects; fix with regression coverage.
4. Run lint, typecheck, unit/integration, evaluation, Firestore emulator, build and relevant browser/E2E checks.
5. Independent QA reruns the changed journeys; address findings and repeat affected checks.
6. Deliver PR and evidence. R2b must pass before adding Daily Tracking features; safe reliability repairs continue if production QA is blocked.

## Acceptance accounting

Mocked AI/cloud E2E, emulator transactions, real production behavior and physical-device testing are separate evidence. An unavailable QA account is BLOCKED, never PASS. Public fixture photos cannot establish measured portion or calorie accuracy.

## Existing architecture decisions

The app already provides Today/history/editing, range estimates, per-account IndexedDB outbox, transaction version checks and tombstones. Cloud storage is intentionally photo-free; saving clears the draft image. Preserve this explicit privacy contract during R2b rather than silently adding photo retention.

## Outcome

- R2a: owner-reported PASS; not independently repeated with an authenticated QA account today.
- R2b: **BLOCKED / NOT RUN** for all five production journeys. Neither repository documents nor the narrowly inspected KcalCue planning thread identified a designated production QA account. The available in-app browser was signed out; no KcalCue Chrome tab was open. No personal account was assumed to be QA, and no production meal was created, modified, deleted or inspected.
- Core reliability: **PARTIAL overall; repaired scope passes local independent QA**. No migration or production configuration change.
- Daily Tracking: existing Today/history/portion editing verified locally; feature expansion remains gated on R2b. No new native, billing or unrelated features.
- Public real-photo fixtures: five categories ready, with source/license/hash evidence in [r2b-fixtures.md](./r2b-fixtures.md). No measured calorie or portion truth is asserted.

## Bugs reproduced and repaired

1. Conflict recovery awaited an IndexedDB write, then resolved the active user again and opened the old draft. Switching accounts could copy account A's meal into B's local draft. Capture account generations, bind pending-job removal to its expected UID, and recheck within locks and after asynchronous boundaries.
2. A delayed account B load could still render after authentication returned to A, because the same-user callback did not invalidate the pending load. Bind loads to the authentication generation and restart a pending account load even when the visible UID matches.
3. `refreshGeneration` was incremented but never read; old snapshots could restore a locally deleted meal. Drop stale snapshots, read records and pending jobs from one state snapshot, and coalesce refresh requests into a follow-up. Local mutation guards prevent applying snapshots during a write.
4. Delayed logout and other mutation continuations could act on the next account. Add account-bound guards before destructive local steps and UI updates.
5. A successful sync left an earlier `trial_access_required` message visible. Keep sync errors separate from operation notices and clear them on successful current-account sync; retry uses the same refresh coordinator.
6. API input validation stripped `nutritionMatch` from the local outbox, so already resolved foods could lose their calorie contribution while offline. Preserve that metadata locally; the server still independently resolves incoming nutrition. No client nutrition trust was added to the API.

## Validation evidence

Runtime: Node **24.15.0**, matching the declared engine range. Dependencies installed from the tracked lockfile in the isolated worktree.

| Gate | Result | Scope |
|---|---|---|
| Lint / typecheck / diff whitespace | PASS | Full repository |
| Unit/integration | 225/225 PASS, 26 files | Includes 7 new component races and 3 outbox regressions |
| Deterministic nutrition evaluation | 47/47 cases PASS | Included in unit suite; standalone command also run |
| Firestore emulator | 8/8 PASS | Java 21, demo-kcalcue, isolated port 8198; actual transactions, conflict/retry/tombstone and account/rules checks |
| Production build | PASS | Next.js production build in E2E harness; synthetic public Firebase config |
| Browser E2E | 6/6 PASS | Chromium 375×812; synthetic Auth/cloud; real public photo preview with mocked analysis, correction, save, reload, history, Today total equality, edit and delete |
| Independent bot | PASS for repaired local scope | Separate agent authored seven behavior tests: baseline 7/7 FAIL, fixed 7/7 PASS; reviewed product diff and separately reran final E2E (6/6 PASS, 14.2 seconds) |
| Production read-only | PASS for limited probes | `/api/status` 200; anonymous `/api/meals?since=empty` 401; Cloud Run revision below |
| Production authenticated real-image flow | BLOCKED | Requires designated QA login; 0 real AI calls, 0 production meal writes |
| Production mobile layout | Limited observation | Anonymous 375 px input view: scrollWidth=viewport=375; no captured console warnings/errors before browser-control failure |
| Physical phone / installed PWA | NOT RUN | Desktop viewport/emulator cannot establish physical-device acceptance |

Production readback: project `gen-lang-client-0116641325`, Cloud Run `kcalcue` in `asia-east1`, ready revision `kcalcue-00005-blk` at 100% traffic, max instances 1, concurrency 4, request timeout 120 seconds. These values were read without exposing environment variables or credentials. The deployed source artifact was not equated to clean Git main; pre-existing local deployment work remains uncommitted and untouched.

## Failure trail and limits

- Initial Node 26 run: 11 tests failed because jsdom `localStorage` was undefined. Node 24.15.0 final run passes; no claim that default Node 26 test compatibility was fixed. An initial Homebrew Node 24.3.0 probe was below the supported engine and is excluded from final gate evidence.
- Sandbox denied local listener startup; authorized localhost E2E execution succeeded. Existing port 8080 belongs to another process; it was left intact and emulator used 8198.
- First new E2E used `import.meta.dirname` in Playwright's CommonJS transform; corrected to `testInfo.project.testDir`, then reran successfully.
- Adding a result/Today calorie comparison initially failed: the test read 65–310 before the numeric input's blur commit, then Today correctly showed 65–190 for saved 150–180 ml. `selectOption` does not move focus. Explicit `Tab` completes the same keyboard edit a user would perform; the unchanged calorie-equality assertions then passed in the independent rerun. No calculation code was changed. Previous failure log/trace retained under `/private/tmp/kcalcue-r2b-independent-e2e-before-blur-fix.log` and `/private/tmp/kcalcue-r2b-before-blur-fix/`.
- In-app browser native confirmation interaction timed out (`Input.dispatchMouseEvent`, then `Emulation.setFocusEmulationEnabled`). This limits manual production UI coverage; automated Chromium dialogs passed locally. No user account or cloud meal was touched. Browser viewport reset was attempted but the control timeout also affected cleanup.
- Automatic approval review rejected disclosure of internal repo/production context to TypeSafe. A separate, wholly fictional todo-list testing question was accepted: JEV `jev-1.13.0`, HTTP 200, 351 input / 39 output tokens. It judged mocked tests insufficient for production proof (0.03 yes) and delayed-response race tests useful (0.83 yes). These are advisory judgments, not QA evidence. No project content or credentials were sent in that accepted request.

## Architecture review and next gate

- Existing durable boundaries: immutable original analysis/originalItems versus editable items; per-record write version and mutation ID; transactional deletes with tombstones; verified UID paths and deny-all direct Firestore rules. Emulator coverage passed. Photo persistence remains intentionally absent.
- Known follow-up scope after R2b: explicit schema/analysis/model provenance and creation timestamps, per-meal kcal display/direct final-kcal editing, and a deliberate opt-in image-history decision. Current photo-free privacy copy must change together with any future retention design.
- Cost controls currently include 10 MiB file checks, image magic-byte checks, 1600 px draft compression, server conversion pixel limits, timeouts and process-local IP rate limits. App Check integration was not found in source; durable per-user AI deduplication/rate limits and streamed request-byte limits remain to assess before broader access. This PR is not a comprehensive security audit or public-launch approval.
- Resume with a designated QA account via its normal login, verify entitlement, then execute each of the five fixtures through the real production journey and independently repeat it. Clean up only that account's newly created QA meals.
- Merge/release remains with the owner: no explicit existing automatic-merge policy was found. Review the PR and reconcile pre-existing deployment work before deploying a build. No merge or deployment occurred during this task.

## Local evidence locations

Temporary raw logs (may be cleaned by the OS): `/private/tmp/kcalcue-r2b-{unit-final,lint-final,types-final,eval-final,firestore,e2e-final,independent-e2e}.log`; independent baseline red tests in `/private/tmp/kcalcue-reliability-audit-20260926/baseline-results.txt`. Durable reproductions are the committed component/outbox tests, E2E, public photo fixture and this report. No credentials, private photos, raw tokens or personal meal records are included.
