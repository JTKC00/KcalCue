# Offline milk-serving Shadow comparator gate (PR #128 Phase 2B1)

This gate exercises the **offline** Phase 2B1 milk-serving Shadow comparator and its
integration with the Phase 1 serving reconciliation engine. It does **not** call
`/api/analyze`, hosted vision, Firebase, Save/History, release guards, or live Shadow
traffic.

## What runs locally

```bash
npm run eval:milk-shadow
```

The script runs:

1. `src/lib/domain/milk-serving-shadow-comparator.test.ts` — existing comparator
   regressions (T/F scenarios, SH01–SH18 matrix extensions, trusted rawAnalysis /
   caller-decision authorization).
2. `src/lib/evaluation/milk-serving-shadow-evaluation.test.ts` — focused named
   synthetic evaluation scenes with **hand-written** nutrient and outcome oracles (not
   copied from engine output).
3. `src/lib/domain/milk-serving-runtime-shadow.test.ts` — Gate C runtime Shadow adapter
   regressions (QA flag/principal gating, anti-double-deduplication, fault isolation,
   redaction privacy, and performance bounds).

Synthetic fixtures live in `src/lib/evaluation/milk-serving-shadow-evaluation.fixture.ts`.
Domain test helpers remain in `src/lib/domain/milk-serving.fixture.ts`.

## Hosted vs offline

| Concern | Offline gate (`eval:milk-shadow`) | Hosted / runtime Shadow |
| --- | --- | --- |
| Input | Synthetic `FoodAnalysis` rows in Vitest | Live analysis snapshots, flags, quotas |
| Engine | Local reconciliation + comparator only | Separate adapter required; legacy response/nutrition remains authoritative |
| Evidence | Deterministic; no network | Paid vision, telemetry, release guards |
| Diagnostics | `toPublicShadowComparisonDiagnostic` allowlist only | Must not leak row IDs, notes, digests |

Use this document and `npm run eval:milk-shadow` before merging offline comparator work
into Draft PR #128. Full repository CI still runs `npm test`, `npm run eval`, Firestore
emulator tests, build, and e2e separately.

Shadow output must not enter API responses, provenance, UI state, drafts, outbox,
Save or History. This offline gate introduces no runtime flag or integration.

## Reproduce typecheck and lint on touched files

```bash
npm run typecheck
npx eslint src/lib/evaluation/milk-serving-shadow-evaluation.test.ts \
  src/lib/evaluation/milk-serving-shadow-evaluation.fixture.ts
```
