# PR #128 Phase 2A P1 corrected contract

Status: correction proposal for separate independent review, not DESIGN_PASS.
Baseline: `e663a1659718681bde41eb324785f629a2c559fd`; base/merge-base
`dfea8c035b08aad44dd3f214b9706daafb87a4e6`.

## Authority and source limits

This gate implements only the reconciliation validator correction and permanent
domain regressions. The comparator, eligibility, workers, diagnostics and release
guards below are DESIGN ONLY. No Shadow flag is implemented or enabled. Legacy
remains the sole authority for API responses, UI, nutrition, coverage, Save,
History and v0–v6 persisted meals. No schema 7 change or historical recalculation.

Sources read: the immutable source at baseline, the complete local
`/private/tmp/KCALCUE_PR128_PHASE2A_CODEX_INDEPENDENT_REVIEW.md`, and its accompanying
`KCALCUE_PR128_PHASE2A_CODEX_REVIEW_BRIEF.txt`. The 24-KB original
`KCALCUE_PR128_PHASE2A_RUNTIME_BRIDGE_SHADOW_DESIGN.md` was not available on this
Mac. The brief explicitly says it is a distillation of a ChatGPT artifact. This
document supersedes the brief's proposed count comparator and clarifies its
contracts; it does not claim a line-by-line review or edit of that unavailable original.

PR stays Draft; Issue #126 stays HOLD. C2/F1 Hosted Acceptance is independent.
QA revision `kcalcue-00045-com` remains non-promotable. No push, Actions execution,
merge, stage, traffic, Firebase or production changes are part of this gate.

## P1-A: slot ownership and validation (implemented)

For contract V1, let C be confirmed accounting units and S be supported slots.
Each c in C owns exactly one existing s in S. The ownership function is injective
and its image is exactly the confirmed slots. Pending/dismissed slots have no owner.
Unit IDs and slot IDs are unique within their namespaces; accepted decision IDs
are unique within the accepted history. Rejected attempts may repeat an ID.

The owner must match its slot's resolved profile, min/max, unit, quantity purpose
and multiplicity; family conflict cannot be confirmed. Existing proof/reference,
disposition, summary and decision-revision validation continues to apply. Validation
is structural consistency of a trusted engine result, not authentication or proof
that arbitrarily authored evidence represents a real photo.

One slot can describe three physical servings as an **aggregate accounting unit**:
600 ml consumed in total, multiplicity 3, one owner, one plan line. It does not
need three unit IDs and must not be calculated as 1,800 ml. Two independent measured
glasses remain two slots and two accounting units. A multi-slot accounting unit
is unsupported in V1: there is no allocation contract for it. Reject it rather
than guessing how its amount should be distributed. The array field `slotIds` is
retained for compatibility but must contain exactly one ID.

The strict validator rejects repeated slot consumption even with fresh unit IDs
and a forged matching summary. `confirmedPortionPlan()` validates again and throws
on invalid input; it neither repairs nor deduplicates forged results. No caller
may catch a validation error and substitute an empty successful plan.

V1 summary names remain compatible:

| Field | Meaning |
| --- | --- |
| supportedServingCount | Sum of multiplicities of all non-dismissed slots, including pending |
| confirmedServingCount | Number of accounting units (`confirmed.length`), not physical servings |
| pendingSlotCount | Number of pending slots, not their physical multiplicity |
| unresolvedGroupCount | Number of unresolved groups; not additive physical servings |

Do not compare `supportedServingCount` to `confirmedServingCount` as equal units.
One-to-one ownership plus matching multiplicities bounds confirmed physical
servings by non-dismissed supported physical servings. The engine remains responsible
for admitting only sufficient evidence into supported slots.

Before correction, the adjusted-summary duplicate of a 250 ml whole-milk result
passed validation and produced two plan lines: 314.15 kcal, protein 16.48 g,
carbs 24.72 g, fat 16.995 g. Legitimate one-serving values are 157.075 kcal,
8.24/12.36/8.4975 g. The permanent test asserts rejection, not projection repair.

## Capture boundary (future integration only)

"Raw" means provider-normalized and schema-validated `FoodAnalysis`, before
`preparePhotoMilkAnalysis`, application notices or deduplication; never raw provider
JSON. Fixture input must undergo the same runtime schema validation; TypeScript
`satisfies` alone is insufficient. Limit to 12 foods and existing bounded text fields.

Only after server QA eligibility may capture create a detached deep snapshot of
all nested data. Deep freeze the detached copy in the worker. Never freeze/mutate
the legacy input or attach anything to analysis, provenance or editable items.
Inputs/outputs cannot share mutable references. Worker decisions are always `[]`.
No client-authored evidence, reconciliations, decisions, digest or row IDs are admitted.

`off`, ineligible requests and all early failures execute zero Shadow validation,
cloning, reconciliation, worker dispatch or comparison. Provider success alone
does not establish QA eligibility. Anonymous demo and configured demo fallback
execute zero Shadow even if a flag or client header requests it.

## P1-B: semantic comparator (design only)

Replace `ShadowAuditSummaryV1` and remove `same_evidenced_count`. A count is one
dimension of equivalence, not an equivalence verdict. Compare in private worker
memory, then discard detailed facts; never log/serialize these facts to the client.

Illustrative types below require strict discriminated runtime schemas in a later
authorized phase. They are not exported runtime contracts in this correction.

```ts
type Known<T> = { state: "known"; value: T } |
  { state: "unknown"; reason: "not_observed" | "unbound" | "unsupported_reference" };
type Range = { min: number; max: number };
type Nutrients = { kcal: Range; protein: Range; carbs: Range; fat: Range };
type PortionMeaning = {
  purpose: "personal" | "aggregate_consumed";
  amount: Range; unit: PortionUnit; multiplicity: number;
};
type PrivateComparisonFacts = {
  observedMilkRows: number;
  physicalServingCount: Known<number>;
  confirmedUnitCount: number;
  confirmedPhysicalServingCount: Known<number>;
  supportedPhysicalServingCount: Known<number>;
  pendingSlotCount: Known<number>;
  pendingPhysicalServingCount: Known<number>;
  unresolvedGroupCount: Known<number>;
  // Bound through server-owned raw-row provenance, never index/name matching.
  units: Array<{
    binding: Known<PrivateServingBinding>;
    portion: Known<PortionMeaning>;
    profile: Known<VerifiedCatalogReference>; // ID + version + reference assumptions
    includedInConfirmedSubtotal: boolean;
    nutrients: Known<Nutrients>;
  }>;
  confirmedSubtotal: Known<Nutrients>;
  fullMilkNutrition: Known<Nutrients>;
  coverage: Known<"complete" | "partial" | "insufficient" | "none">;
  unresolved: boolean;
};
type Comparison =
  | { kind: "semantically_equivalent" }
  | { kind: "investigation_required";
      reason: "invalid_contract" | "semantic_difference" | "execution_failure" }
  | { kind: "uncomparable_without_user_decision";
      reason: "unknown_binding" | "unknown_portion" | "unknown_profile" |
        "pending_state" | "unsupported_reference" };
```

`PrivateServingBinding` is a worker-internal relation between the original
snapshot's observations and each path's accounting unit, with explicit same,
separate or unknown relationship. It is not the editable index/name ID. If legacy
dedupe destroys a reliable binding, do not reconstruct identity by vessel kind or
array order. Physical counts on legacy rows are unknown unless independently
supported; `foods.length` is only observed rows. Internal IDs never enter diagnostics.

Evaluation order:

1. Gate input, engine and output validation; validate plan ownership before any
   calculation. Any failure yields investigation; missing downstream stages are
   unknown/unattempted, not zero or equivalence.
2. Project each side's actual semantics using the same frozen catalog and
   conversions, without replacing legacy results. Preserve profile assumptions,
   quantity ranges, personal/aggregate purpose and multiplicity. Compare physical
   counts, accounting units and nutrition as separate dimensions.
3. A demonstrable difference in any mutually known dimension yields
   `investigation_required/semantic_difference`, even if other fields are unknown.
   Different aggregation shapes are not declared equivalent without a proven
   partition; conservatively investigate. Count direction does not order nutrition.
4. Otherwise any unknown binding, pending quantity/type, unsupported unit/reference
   or unresolved relation yields `uncomparable_without_user_decision`. Two unknowns
   are not equal facts. No client prompt or decision is performed by Shadow.
5. Only fully comparable, matching physical identities/counts, unit semantics,
   quantities, purpose, profile/reference, four nutrient ranges and coverage may
   yield `semantically_equivalent`. Equal numeric totals alone are insufficient.

Calculation: total consumed amount on a plan line is its min/max exactly once;
multiplicity describes represented physical servings. A personal line is already
one resolved personal amount; do not multiply it again. Per-serving amounts must
be explicitly represented as distinct lines or an explicitly derived aggregate,
never inferred by the comparator. Aggregate 600 ml/multiplicity3 = 376.98 kcal,
protein19.776 g, carbs29.664 g, fat20.394 g for the whole-milk reference.

Use existing local catalog formulas/conversions as read-only functions in the
future private comparator. `whole` maps `whole-milk`, `oat` maps `oat-milk`, `soy`
maps `unsweetened-soy-milk` with that reference assumption retained. `low-fat`,
`other`, absent profiles or unsupported conversions yield unknown; no fallback
whole milk, ml→g shortcut or network nutrition lookup. Unit/reference/purpose
equality is exact; finite nonnegative min<=max are required. For floating-point
nutrient comparisons only, absolute tolerance <=1e-6 kcal or g, no relative
tolerance and no display rounding before comparison.

Pending/exclusive groups contribute zero **known confirmed-subtotal** nutrition.
That does not make their real nutrition zero: `fullMilkNutrition` is unknown if
such portions remain. Missing profile/conversion on a confirmed plan also makes
the calculated subtotal unknown, rather than skipping that line. Legacy totals
may numerically be zero with coverage none; that is not evidence of no consumption.
Coverage compares the actual legacy coverage and a separately derived Shadow
coverage with explicit eligible/unsupported/pending accounting; do not pretend
legacy row-coverage is a serving-count measure. Incompatible coverage denominators
make comparison uncomparable, even if labels match.

Required counterexample: structured 1,000 ml, note `飲了250ml（包裝標示容量1L）`.
Both known physical counts are one in the synthetic fixture. Legacy reference
calculation: 628.3 kcal, protein32.96, carbs49.44, fat33.99 g. New confirmed plan:
250 ml personal, 157.075 kcal, protein8.24, carbs12.36, fat8.4975 g. This must yield
investigation for portion/nutrient difference, never equivalence. The regression
checks both real domain paths and all four nutrients; no runtime comparator exists.

### Diagnostics contract

Keep stage/outcome counters in bounded process memory, not per-request audit
objects. Four denominators are distinct: eligible requests; dispatch attempts
(including queue rejection); strictly validated results; fully comparable results.
Record separate invalid/incomplete evidence counts. Equivalence numerator is only
fully comparable equivalent results; never dilute failures with skipped requests.

Strict fixed-enum events internally: `eligible`, `attempted`, `validated`,
`comparable`, `equivalent`, `uncomparable`, `investigation`, and failure stage
`capture|admission|worker|input|engine|output|projection|comparison|diagnostics`.
Version constants come from the build, not input. A failure variant must not carry
successful counts or nutrients. No `?? 0` on absent data.

Default sink is process-memory counters, reset on process shutdown or after 15
minutes; cap 32 fixed counters. No raw text, images, claims, portions, nutrient
vectors, digests, IDs, account/meal data, correlation keys, exception names/text,
stack traces, timestamps, content-dependent timing or dynamic enum labels in logs,
APM/traces, stderr, crash dumps or metrics. Generic application error sanitization
is not sufficient. Do not use the normal vision logger or analyze timing logger.

Any later export requires separate approval: fixed 15-minute windows, at least
20 eligible samples before output, sample counts bucketed 20–49/50–99/100+,
independently bucketed outcome counters, fixed version allowlist, no per-request
records or joint tuples. Smaller windows are suppressed, not merged with IDs.
No export endpoint is added here. Diagnostics failure marks the QA session
incomplete in its supervisor; loss of supervisor evidence itself fails the gate.

## P1-C: QA eligibility and release isolation (design only)

Selected flag name: `KCALCUE_QA_SERVING_SHADOW`, server-only (never `NEXT_PUBLIC_`).
Only absent or exact `off` disables, exact `qa_shadow` requests eligibility. Empty,
whitespace, different case, unknown values, duplicate entries and secret-reference
configuration are invalid; effective Shadow is disabled and QA startup fails
closed. Invalid configuration does not break or authorize ordinary legacy requests.

Execution requires ALL of:

- A separately approved candidate's immutable image digest and revision identity,
  checked against trusted deployment metadata and a server-owned approved manifest.
  Client Host/header/env self-assertions are not sufficient.
- A verified authenticated Firebase principal, including verified email, current
  trial entitlement and a separate QA principal allowlist. Trial allowlist alone
  does not establish QA eligibility. Ordinary accounts do not qualify.
- A short-lived server-issued QA run context bound to that principal, candidate,
  branch (`live` or fixture), purpose, nonce and expiry. Verify signature and
  context server-side; reject expired, mismatched, duplicate or replayed contexts.
  A form field/header may carry this token but cannot grant permission by itself.
- All ordinary admission checks and successful validated raw analysis. The QA
  suspected-milk fixture trigger is not a Shadow credential. No auth shortcut.

No new authorization endpoint is implemented here. Missing candidate manifest,
QA registry or run-context issuer means ineligible, not a client-controlled fallback.
0% normal traffic is an exposure limit, never authentication; tagged URLs may
still be reachable. Demo, including missing-config fallback, is always excluded.

Future guards must inspect the **target revision's actual full env representation**,
not local shell settings. Promote, rollback and access-promote reject presence
of ANY Shadow variable, even literal `off`; duplicates, empty/unknown/secret ref
and uncertain env shape reject before any traffic mutation. Retain the old
`KCALCUE_QA_SUSPECTED_MILK` prohibition and access env whitelist. Ordinary stage
and access-stage explicitly clear QA-only variables. An approved QA-only staging
path must verify the resulting revision identity, exact env and zero normal
traffic before declaring success. No release script changes in this gate.

## P1-D: execution/resource boundary (design only)

Selected production-safety requirement: **no reconciliation, strict Shadow schema,
comparison or diagnostic serialization on the legacy request event loop**. An
async wrapper or `Promise.race` around synchronous CPU work is insufficient.
Run these stages in a killable isolated worker process on dedicated QA resources,
with CPU quota separate from the web process. A normal worker thread on a shared
unbounded Cloud Run instance does not establish CPU isolation.

Future implementation must choose a platform that can enforce separate CPU and
memory budgets (dedicated QA runner/worker service), rather than assuming the
present web deployment provides them. The initial acceptance implementation can
be an offline synthetic QA replay harness on dedicated resources; it must not be
presented as hosted runtime acceptance. A networked worker dispatch, if chosen,
requires separate authorization and private authenticated transport; the earlier
brief's blanket "no network" must not be silently relaxed. No second provider,
nutrition, Firebase or quota call is permitted in any worker design.

Worker budget proposal, to be validated before any runtime integration:

| Resource | Hard policy |
| --- | --- |
| Input | Existing schema text bounds, <=12 foods, <=256 KiB encoded payload; reject excess, no truncation |
| Pool | One executing job, <=2 queued jobs; non-blocking admission, drop on saturation |
| CPU/memory | Dedicated <=1 vCPU, process/container memory cap 128 MiB; no inherited secrets, credentials, network clients or user files |
| Lifetime | Parent-enforced wall timeout 500 ms from admission (queue included); CPU cap 250 ms; terminate process on overrun |
| Cancellation | Request cancellation before response/enqueue cancels capture; QA-run cancellation kills queued/running jobs; supervisor always clears buffers |
| Output | One bounded enum outcome <=1 KiB; no raw facts returned; worker memory destroyed between jobs |
| Cleanup | Kill and reap on timeout/crash/cancel; release slot once; zeroize/release references; no temp files/core dumps; bounded restart, no automatic job retry |

These are engineering limits, not measured latency guarantees. Local resource
stress and hosted enforcement are future mandatory gates. If a platform cannot
enforce them or workers cannot initialize within budget, reject QA execution and
change the worker environment under separate approval; never increase legacy latency.

Future producer admission is try-only and never awaited for Shadow completion.
Release legacy live-admission/quota locks and finalize the legacy response and
timing independently. Shadow runs after the response boundary via a lifecycle-safe
supervisor, not an untracked fire-and-forget promise. Queue-full, process failure,
timeout or restart never retries the paid provider or changes HTTP status, body,
quota, totals or Save. Worker failure produces investigation/incomplete QA evidence.

Snapshot capture/encoding itself has a cost. A route clone cannot honestly promise
zero latency impact. Before a live QA adapter is authorized, measure and bound
this cost on its own candidate, prove no waiting on worker/queue, and demonstrate
legacy response equivalence. If the requirement is literally zero extra request
CPU/latency, select offline synthetic replay only. No runtime integration may claim
this resource guarantee solely from this document or the local validator tests.

Worker errors are handled through fixed supervisor reason enums. No error object
can escape into analyze's general catch/finally or normal telemetry. Do not forward
process stderr, exception text or dump files. Every missing outcome, queue drop,
timeout, validation failure or diagnostics failure invalidates the corresponding
QA sample and prevents treating the run as a release pass. Legacy success is not
evidence that Shadow succeeded.

## P1-E: decision identity (existing semantics retained, regression protected)

Decision IDs name **accepted events in one server-owned scene's accepted history**,
not every attempted command. This is deliberate: rejected decisions have no state
effect or revision, and a pure engine has no durable attempt registry. Preserving
this policy avoids inventing state or changing the accepted protocol in this gate.

| Input | Required result |
| --- | --- |
| New ID, correct digest/revision, valid command/target | Accept once; revision +1 |
| Same accepted ID, exactly same complete body | Idempotent no-op, including original expected revision |
| Same accepted ID, changed command, target, digest or expected revision | `decision_id_conflict`; no mutation/revision |
| Rejected ID reused with corrected or changed body | Re-evaluate normally; may accept; rejection did not reserve ID |
| New ID with stale digest/revision | Reject, no mutation/revision |
| Unknown target or unsupported undo | Reject; undo has no accepted representation |

The full canonical decision envelope defines replay equality. The engine checks
accepted-ID replay before current revision admission; a genuine exact replay
therefore stays idempotent after later accepted commands. The accepted list is
unique, ordered and bounded; revision equals accepted length, each expected
revision equals its zero-based history position. Rejected diagnostics may reuse
accepted IDs (e.g. an accepted-body conflict) and are not the event ledger.

`sourceDigest` binds scene/evidence and fixed engine/grammar versions, not the
accepted history. It is an FNV content identity, not a signature or authorization.
Changed scene/raw source changes digest; permutations of one scene do not. Pure
calls rebuild from the complete effective accepted history; passing only a new
command with revision1 to a new invocation fails rather than restoring history.

Future host boundary must authenticate ownership first, then load the authoritative
account+meal+scene record, recompute trusted source identity, compare revision and
apply atomically. The server assigns a fresh non-reused scene identity per analysis
under its owner. Account/meal/scene mismatch rejects before engine evaluation,
even if a caller copies a valid digest/ID. IDs may repeat in other accepted
histories but may not replay events across them. Index/name IDs are insufficient.
CAS and an event store are not implemented in the pure engine; no cross-account
security claim is made by its scene-digest regression.

If a future API requires all attempted IDs to be reserved, it needs a separate
bounded owner/meal-scoped attempt registry with body equality, TTL/replay behavior
and transactional reservation. That is a versioned host contract change, not a
validator patch. Phase 2A Shadow always passes decisions=[] and exposes no commands.

## Change sequence, compatibility and remaining gates

1. Reproduce adjusted-summary slot reuse at exact baseline; retain red evidence.
2. Tighten V1 one-slot ownership, accepted-ID uniqueness and projection validation.
   Keep summary names/wire fields and engine algorithm; preserve all Phase 1 tests.
3. Add permanent positive/negative domain witnesses, comparator numeric counterexample
   and accepted-history replay regressions. Run focused then full local gates.
4. Review this corrected design and SH01–SH18 matrix independently. No comparator,
   worker, flag, release script, route, UI or persistence code ships in this step.
5. Only separate approval may authorize future adapter/worker/guard implementation,
   followed by independent source/security review and separately approved hosted QA.

No data migration: engine has not been connected to runtime or persistence, current
engine output already has one unit per slot. Older forged/multi-slot results now
reject. Trusted engine output is regenerated rather than coercing invalid results.
No contract-version bump is needed for this tightening of validator guarantees;
the accepted engine-generated V1 output is unchanged. Before future integration,
version the comparator/adapter and validate every crossing rather than relying on
TypeScript casts or unknown-key stripping.

Local rollback is reverting only this correction's validator/tests/docs after
preserving evidence; there is no production rollout to roll back. Do not weaken
uniqueness validation to regain an apparent pass. A future flag-off rollback only
stops Shadow; it cannot justify promoting a revision containing a QA-only flag.

Residual risks: P1 future runtime isolation/eligibility/release guards remain
unimplemented by scope; P1 comparator/coverage/binding correctness requires its own
tests and independent review; P1 host ownership/CAS is not supplied by the engine;
P2 worker budget feasibility and diagnostic aggregation require measured proof.
The missing original artifact limits comparison against its complete text. None
of these is presented as a production fix or permission to integrate runtime.
