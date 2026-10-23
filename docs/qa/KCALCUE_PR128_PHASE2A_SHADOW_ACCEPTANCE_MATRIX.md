# PR #128 Phase 2A corrected SH01–SH18 acceptance matrix

Baseline `e663a1659718681bde41eb324785f629a2c559fd` plus local P1 correction.
Normative contract: [corrected design](../design/KCALCUE_PR128_PHASE2A_P1_SHADOW_CONTRACT_CORRECTION.md).
All fixtures synthetic; local domain proof, runtime adapter proof and Hosted
Acceptance are separate columns. Test existence never means a review thread is resolved.

`PASS` = executed gate with stated evidence; `FAIL` = reproduced failed oracle;
`NOT CHECKED` = specified but not implemented/executed here. A design specification
cannot turn a runtime test into PASS. No paid hosted calls or Actions in this gate.

## Acceptance specifications

| Gate | Deterministic fixture / negative injection | Required oracle (in addition to strict validation) | Local evidence in this correction | Future Shadow/runtime evidence |
| --- | --- | --- | --- | --- |
| SH01 | One carton repeated as two observations; identical and divergent packaging notes | One supported physical serving; no unsupported second confirmed nutrition; full raw snapshot retains both observations | Phase 1 suite preserved | NOT CHECKED: pre-legacy snapshot and equivalence |
| SH02 | Two true cartons + duplicate third + genuine glass, then remove/add glass and unrelated sandwich | Three true physical servings recoverable; duplicate stays unresolved, no singleton escape; slot ownership injective | Phase 1 suite preserved | NOT CHECKED: semantic comparator |
| SH03 | Explicit affirmative three cartons; three-cup 600 ml aggregate | Physical count3; aggregate unit count1, multiplicity3; total 600 ml once (376.98 kcal whole), all macros match | PASS: aggregate positive plus forged duplicate rejection | NOT CHECKED: comparator distinguishes units/counts |
| SH04 | Carton/glass with conflicting notes, soy named in generic glass, spoon container | Family attribution separate from vessel; unrelated object cannot support milk; genuine family/serving preserved | Phase 1 suite preserved | NOT CHECKED: binding/coverage comparison |
| SH05 | Competing maximum cliques; unknown outside all cliques; add independent serving | No arbitrary winning identity or released unknown; unresolved quantities excluded | Phase 1 suite preserved | NOT CHECKED: comparison yields unknown/investigation |
| SH06 | Same blue-dot cup 250 vs400, both row orders, remove one anchor | Identical exclusive uncertainty, zero confirmed four-nutrient subtotal, full milk nutrition unknown; removing evidence cannot strengthen | PASS: pending/exclusive zero regression; existing permutations preserved | NOT CHECKED: unknown result enum, no ??0 |
| SH07 | Anchored whole400 + unbound generic/oat alternatives; distinct measured whole250/400 | Known serving never displaced; separate slots give 408.395 kcal; unbound rows cannot steal ownership | PASS: distinct-slot and multi-slot forgery regressions | NOT CHECKED: stable raw provenance binding |
| SH08 | Structured1000 but consumed250/package1L; structured null but consumed250; poured180 distinct from stock | Equal count1 does not imply equivalence: 628.3 vs157.075 kcal; protein32.96 vs8.24, carbs49.44 vs12.36, fat33.99 vs8.4975; investigation. Null structured does not erase affirmative consumed amount | PASS: real legacy/domain four-nutrient witness; Phase 1 amount-role tests preserved | NOT CHECKED: comparator outcome, unsupported conversions |
| SH09 | Stock1L poured180 into glass; stock only; three cups combined600 vs per-cup estimate | Capacity/transfer not independently consumed serving; aggregate never multiplied again; unsupported portion remains unknown | Phase 1 suite preserved; PASS aggregate numeric witness | NOT CHECKED: purpose/reference/coverage semantics |
| SH10 | `三盒嗎`, `係咪三盒`, `未證實`, `三盒吗`, `can't see three`, quoted "three cartons", affirmative two/three | Question/negative/uncertain/quoted count cannot increase support; affirmative count retained; Traditional/Simplified/Cantonese/English bounded grammar | Phase 1 suite preserved | NOT CHECKED: all language fixtures through adapter |
| SH11 | Divergent carton notes and `not the same glass` referent; `not a different glass`; nearby second container holding spoons | Correct attribution; glass negation never establishes separate carton; spoon vessel never establishes milk | Phase 1 review-thread semantic tests preserved | NOT CHECKED: real snapshot binding. GitHub threads unchanged |
| SH12 | Permute fixed scene rows; unrelated food insertion; new scene with same text; independent invocation | Same scene semantic decisions/digest/totals invariant; changed scene bound separately; no index identity; repeated processing stable | Existing metamorphic suite preserved; PASS changed-scene replay rejection | NOT CHECKED: server owner/meal binding |
| SH13 | New unitId reuses confirmed slot; repeated slot in unit; single unit covers two slots; duplicate IDs; mismatched portion/profile/multiplicity/status/ref; forged summaries; accepted-ID duplication | Strict schema rejects all; confirmedPortionPlan throws rather than dedupes; valid aggregate and distinct containers accepted | PASS: focused ownership/ID/status/count/aggregate tests plus Phase 1 strict tests | NOT CHECKED: Shadow input/output failure classification |
| SH14 | Exact accepted replay; same accepted ID changed command/digest/revision; stale source; rejected-ID corrected body; history omitted; undo; copied context across owner/meal | Accepted history unique; exact replay no-op; changed accepted body conflict; rejected reuse allowed by documented policy; no rejection revision; host denies ownership mismatch before engine | PASS: focused replay/revision tests. Host authorization NOT CHECKED | NOT CHECKED: atomic CAS, cross-account/meal denial; decisions=[] in Shadow |
| SH15 | Demo explicit/fallback; fixture; live; flag off/ineligible; all request early returns; provider throw, quota denial/duplicate; client second preparation | Branch counts below; exact legacy response/status/provenance/totals, zero Shadow in demo/off/ineligible/failure; no extra paid call/reservation | Source boundary review only; existing full tests retained | NOT CHECKED: runtime admission/byte equivalence |
| SH16 | Canary strings in nested notes/claims/IDs/errors; successful/failing Shadow; Save/offline/outbox/History/account switch; logger/APM/process stderr spies | Zero Shadow data in response, provenance, UI state, storage, photo assets, logs/traces/dumps. Only approved aggregate counters in memory; small-sample export suppressed | No runtime/persistence code changed; diff/source check | NOT CHECKED: full sink spies and persistence round trip |
| SH17 | <=12 rows/max text; malformed13 rows; oversize bytes; invalid snapshot; output forgery; stall/throw/crash; saturation; cancel; logger fail | Hard process termination/budgets; bounded queue/memory; exactly-once cleanup; no legacy effects; every missing/failed sample invalidates QA; downstream unknown not zero | PASS validator rejection only | NOT CHECKED: CPU isolation, memory, timeout, queue/cancel/cleanup and capture latency |
| SH18 | Absent/off/qa_shadow/empty/whitespace/case/unknown/duplicate/secret-ref env; normal vsQA candidate; ordinary vsQA user; client bypass; expired/replayed context; all promote/rollback/access-promote paths | Exact config parsing plus all server eligibility checks; any Shadow variable on target blocks traffic mutation including off; preserve old QA restriction; candidate0% alone grants nothing | Design only; no flag or guard implemented/enabled | NOT CHECKED: mocked release command assertions with zero traffic calls, then separately authorized deployment readback |

## SH15 branch oracle

Successful paid live requests have exactly one paid vision call and one durable
reservation attempt. Fixture and demo are different branches:

| Branch | Paid vision calls | Demo provider calls | Durable quota reservations | Shadow jobs |
| --- | ---: | ---: | ---: | ---: |
| Anonymous/explicit/fallback demo | 0 | 1 | 0 | 0 always |
| Authenticated QA fixture, fully Shadow eligible and schema valid | 0 | 0 | 0 | <=1 |
| Successful live, fully eligible and schema valid | 1 | 0 | 1 | <=1 |
| Any successful legacy branch, Shadow off/ineligible | Existing branch count | Existing branch count | Existing branch count | 0 |
| Rate/body/timeout/auth/paused/image/attempt-invalid/live-lock rejection | 0 | 0 | 0 | 0 |
| Quota store failure/duplicate/denial | 0 | 0 | 1 attempted | 0 |
| Live provider failure/invalid provider response after admission | 1 attempted | 0 | 1 | 0 |

Counts apply at the exact branch admission point: failures before reaching a
component cannot increment that component. Fixture fast path bypasses attempt and
quota under the existing route; new Shadow eligibility must not change it. Worker
saturation/failure never retries provider/quota. Request abort before enqueue
means no job; if already admitted, cancellation terminates it with failed QA evidence.

## Required security failure experiments before future integration acceptance

Use fake clocks and isolated processes with known synthetic inputs; no cloud
calls required for local guard tests. Spy every network/provider/quota/log/persistence
sink, inject every stage failure and assert exact legacy output equivalence. Kill
a CPU-spinning worker with an external supervisor; timers on that worker's event
loop are not valid evidence. Verify time-to-kill, process reap, queue bound and
memory cap under repeated cancellation/restart. Measure capture-only request cost
against baseline separately from worker latency. Configure a fake revision whose
env contains Shadow as `off`, duplicate or secret ref and assert all traffic commands
remain uncalled. Test QA eligibility independently of HTTP Host/tag routing.

Inspect counters' denominators when samples are skipped, dropped or lost. Unknown
facts may never inflate success/equivalence. No sourceDigest, hashed identity,
per-request count tuple or exception text is an allowed "safe" telemetry substitute.

## Gate disposition

This gate may be ready for independent **correction re-review** after local
validator/tests and document review. Runtime Shadow, new guards/flag, hosted QA,
authorization/CAS, schema7, C2/F1 and release remain NOT CHECKED and unauthorized.
Local synthetic tests cannot close these future gates or GitHub review discussions.
