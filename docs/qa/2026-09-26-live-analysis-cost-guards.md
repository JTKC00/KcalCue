# Live analysis cost guards — 2026-09-26

## Problem and implementation

The analyze endpoint authenticated Live requests but limited them only by IP. One verified account could use several networks or tabs to start concurrent provider work. The OpenAI SDK also retried a failed interactive request twice, so one admitted application request could cause three transport attempts.

This branch is stacked on PR13 at `89a203cc2b1429fbcae0a7bfbdaccb4f3affd29f`. It preserves the bounded multipart reader and existing IP preguard, and adds admission after verified authentication and valid-image checks:

- A verified Firebase UID has a token bucket with capacity 5, refilling 5 tokens per 60 seconds, plus at most one in-flight Live analysis. The UID comes only from `authenticated().user.id`.
- A simultaneous rejection does not consume a UID token. An admitted attempt consumes its token even if the provider throws, rejects or aborts; unknown provider work is not refunded.
- The idempotent release runs in `finally` after the provider promise settles. Client cancellation alone cannot release work that is still pending.
- The UID map is separate from the public IP map and has a maximum of 5,000 entries. At capacity, only fully refilled entries with no in-flight work can be pruned. If none can be pruned, admission fails closed with the existing 429 `rate_limited` response and `Retry-After: 60`. Active work and unexpired quota are never evicted for a new UID.
- Demo, authentication failure, missing images, invalid images and oversized input do not acquire Live admission. Existing IP limits still apply to all requests.
- The interactive provider changes only `maxRetries: 2` to `maxRetries: 0`. The current 90-second HTTP timeout, 100-second abort signal and caller cancellation are preserved.

## Regression evidence

Node 24.15.0; installed OpenAI SDK 7.9.0. No external provider, production, credential or database access was used.

Fourteen new tests cover five admission-helper cases, six route cases and three real-SDK transport cases. Existing tests also assert that Demo, authentication failure and invalid input never call admission.

- Helper: exact refill boundary; concurrent rejection without charging; idempotent release that cannot unlock newer work; capacity fail-closed; preservation of in-flight users after refill; unexpired quota surviving capacity pruning; UID quota surviving 10,000 public-IP bucket insertions.
- Route: same verified UID across different IPs and untrusted user headers; independent UID quota; concurrent users; success, synchronous throw and asynchronous rejection; cancellation with a deliberately pending provider followed by eventual settlement.
- SDK: installed SDK with an injected in-process fetch, using the options actually passed by the provider, for HTTP 500, HTTP 429 and connection failure. Each uses exactly one transport attempt. Existing provider mocks continue to cover public-error classification, caller cancellation and timeout composition.

RED evidence: with the new tests and the old `maxRetries: 2`, all three SDK transport tests failed because the transport was called three times, and the existing options assertion failed because it expected zero retries. The run reported **4 failed / 57 passed**. Only the one-line provider option was then changed; no test expectations were weakened.

GREEN commands and results:

```sh
PATH=/Users/jamestong/.nvm/versions/node/v24.15.0/bin:$PATH npm test -- src/lib/server/live-analysis-admission.test.ts src/app/api/analyze/route.test.ts src/lib/providers/food-vision/providers.test.ts src/lib/server/request-body.test.ts src/lib/server/rate-limit.test.ts src/lib/server/auth.test.ts src/components/kcalcue-app.test.tsx
# 7 files, 86 tests passed

PATH=/Users/jamestong/.nvm/versions/node/v24.15.0/bin:$PATH npm test -- src/app/api/meals/photo/route.test.ts src/app/api/meals/route.test.ts src/app/api/nutrition/resolve/route.test.ts src/components/image-input.test.tsx
# 4 files, 26 tests passed

PATH=/Users/jamestong/.nvm/versions/node/v24.15.0/bin:$PATH npm run lint
PATH=/Users/jamestong/.nvm/versions/node/v24.15.0/bin:$PATH npm run typecheck
git diff --check
# All passed
```

The combined scoped runs pass **112 tests across 11 files**. The existing component tests emit jsdom's `Window.scrollTo()` not-implemented warning; there were no failed assertions. These are local synthetic checks. Independent review, full integration/build and browser acceptance are coordinated by the root agent; they are not claimed by this report.

## Limits, tradeoffs and integration

The UID guard is process-local. Restarting the process clears it, and another instance would have its own quotas and in-flight state. It improves the current restricted single-instance trial but is not a durable spending cap, daily budget or cross-instance lock. A durable atomic quota/lease design is needed before scaling; this patch creates no new Firebase data or paid resource.

Disabling transparent SDK retries makes transient provider failures visible sooner. Explicit manual retry remains available, but it may repeat upstream work whose earlier result was unknown. Neither the in-flight guard nor `maxRetries: 0` establishes provider billing idempotency or guarantees zero cost after cancellation.

The existing IP policy is retained, including its shared-IP/NAT limitations. This patch does not change deployment configuration, billing, App Check, image scaling or USDA behavior. Its local tests do not assert a production header trust contract or production cost bound.

The owner's deployment/evaluation work is not on this base. When integrating, retain the owner's `KCALCUE_ANALYSIS_ENABLED` gate and evaluation execution override; the corresponding owner provider change is only `this.execution.maxRetries ?? 2` to `this.execution.maxRetries ?? 0`. Do not replace the owner's whole provider or analyze route with this branch's older base. PR16 nutrition authorization remains a separate integration requirement.

Root validation after implementation: 265/265 full unit tests (including the 47 deterministic nutrition invariants), production build and 5/5 mobile Chromium E2E pass. The independent reviewer separately passed 67 scoped tests and 12 additional probes, including real SDK timeout behavior with one transport attempt. No blocking findings were reported. These browser tests use synthetic auth/cloud responses, not production provider acceptance.

Exact-head CI and compatibility with the owner's deployment/evaluation snapshot are recorded separately in the PR. No deployment or production configuration change was performed.
