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
- R2b: **PARTIAL overall**. The owner subsequently designated a QA account and restored its login. Grok Bot ran all five real-photo cases; independent review verified six actual cloud records (five cases plus an auxiliary salad), the banana edit, and the first scoped deletion. The remaining five deletions and empty readback were later verified; see the dated final addendum below. No non-QA account data was accessed.
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
| Production authenticated real-image flow | PARTIAL overall | Five real-photo cases, actual six-record GET, edit, all scoped deletes and empty reload were later verified; vision quality and full failure matrix remain open |
| Production mobile layout | Limited observation | QA mobile 375×812 Today/History screenshots after cleanup; physical-device use and full interaction matrix not verified |
| Physical phone / installed PWA | NOT RUN | Desktop viewport/emulator cannot establish physical-device acceptance |

Production readback: project `gen-lang-client-0116641325`, Cloud Run `kcalcue` in `asia-east1`, ready revision `kcalcue-00005-blk` at 100% traffic, max instances 1, concurrency 4, request timeout 120 seconds. These values were read without exposing environment variables or credentials. The deployed source artifact was not equated to clean Git main; pre-existing local deployment work remains uncommitted and untouched.

## Resumed production evidence and notice repair

After the owner designated the QA account and completed login, actual response bodies were captured through the normal browser Network UI. Only sanitized body artifacts were exported; no bearer tokens, HAR or authentication headers were retained in this report.

- I full GET: six QA records; sanitized SHA256 `4219719bd1468928a6bb39e98ea141ef8ab30ee32bf000f8392a743388990be6`. Root and an independent reviewer compared all five photo cases, stored nutrition structures, original analysis and current values. Earlier UI-reconstructed JSON was excluded as cloud evidence and superseded by this actual response.
- K edit POST: banana v3, breakfast, 120g; SHA256 `1bc10cad43ecf28e3c6e5552f57d3ac3f58cbf40958968a08e4bfd566249a491`. Original analysis and originalItems remained 80–140g.
- L DELETE returned 200/ok for the auxiliary salad only. The subsequent itemful GET has exactly five records; banana equals K and the other four equal I. GET SHA256 `4163f902532b3e309dad5024a1c497e127d16d4e725e16221bd2a892e76389fa`. Today/history show 575–1395 kcal with 4/15 items included; unknown items are not counted as zero nutrition.
- At this point in the 2026-09-26 run, five QA meals still awaited deletion. The later M/N captures completed and independently reviewed that cleanup; see the dated final addendum below.

The production screenshots revealed a stale yellow local-pending acknowledgement after confirmed cloud deletion. Save/delete/clear-all acknowledgements were stored as ordinary notices, so successful refreshes cleared sync errors but left these messages. They are now tagged as pending-sync: the existing account/generation-guarded durable snapshot clears only this category when all jobs are gone, or reports the remaining count including error jobs. Ordinary storage/auth/draft messages and dismissed notices are preserved.

Validation of this follow-up:

- Eleven new notice regressions plus eight existing journal/race cases: 19/19 PASS, independently rerun on Node 24.15.0. The final save/delete/clear-all tests all fail against the prior source at the real post-ACK lingering-banner assertion.
- Full branch: 236/236 tests, lint, types, 47 deterministic nutrition cases, production build and 6/6 mobile E2E PASS. The photo journey now asserts the pending notice disappears before reload after both save and delete.
- Integration with the unchanged owner deployment snapshot and PR12–17: Node 24.15.0 and Node 26.7.0 each 346/346 tests; lint/types/build and 7/7 mobile E2E PASS.
- This is source/local evidence. The notice repair has not been deployed; production UI remains subject to the known finding until a separately authorized release.

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
- The designated-QA cleanup and independent final evidence review were completed after this source snapshot; see the dated final addendum below. Do not confuse the pending notice repair release with already verified cloud data.
- Merge/release remains with the owner: no explicit existing automatic-merge policy was found. Review the PR and reconcile pre-existing deployment work before deploying a build. No merge or deployment occurred during this task.

## Local evidence locations

Temporary raw logs (may be cleaned by the OS): `/private/tmp/kcalcue-r2b-{unit-final,lint-final,types-final,eval-final,firestore,e2e-final,independent-e2e}.log`; independent baseline red tests in `/private/tmp/kcalcue-reliability-audit-20260926/baseline-results.txt`. Durable reproductions are the committed component/outbox tests, E2E, public photo fixture and this report. No credentials, private photos, raw tokens or personal meal records are included.

## Final evidence reconciliation (2026-09-28)

This addendum corrects the in-progress snapshot above; it does not imply that later source PRs were deployed. The designated-QA run produced an authenticated HTTP 200 `/api/meals` full response with six records, including the five real-photo cases. Its sanitized body has SHA-256 `4219719bd1468928a6bb39e98ea141ef8ab30ee32bf000f8392a743388990be6` (`/private/tmp/kcalcue-grok-r2b-20260926/readback-I`). A later editor POST preserved the original AI analysis while changing the user's final banana amount. Independent review accepted these body-level cloud facts and excluded earlier UI-reconstructed responses.

The auxiliary salad was deleted first. Five further normal QA-only UI deletes returned HTTP 200, each followed by an itemful GET with record counts **4 → 3 → 2 → 1 → 0** (`/private/tmp/kcalcue-grok-r2b-20260926/cleanup-M`). The last body was `records: []`. A separate normal browser document reload returned authenticated HTTP 200 and showed empty Today and History, with no pending/draft indicators (`/private/tmp/kcalcue-grok-r2b-20260926/reload-N`). The lingering local-sync toast noted during cleanup disappeared after that verified document reload. No further deletion of this six-record set is needed.

This establishes the core cloud persistence/edit/delete/cleanup journey for the **2026-09-26 production build**. It does not establish a full R2b PASS: production upload/AI/API failure injection, in-flight refresh and retry/race coverage, physical-device PWA acceptance, and AI food/individual-portion quality remain incomplete. On 2026-09-28, independent visual QA of five new development photos plus a five-photo model holdout found wrong or omitted foods and unsupported personal portions; see [R2b issue #90](https://github.com/JTKC00/KcalCue/issues/90#issuecomment-5860035387). The alternate model was not promoted. [PR #91](https://github.com/JTKC00/KcalCue/pull/91) adds a visible user review prompt; [issue #92](https://github.com/JTKC00/KcalCue/issues/92) tracks the underlying unknown-portion data contract. Both are source/review work, not evidence of a new production release.
