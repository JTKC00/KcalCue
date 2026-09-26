# API request input limits — 2026-09-26

## Problem and scope

Multipart routes checked `Content-Length` before parsing, but a missing or understated header bypassed that early check. The meals route checked decoded text length only after reading the whole body; nutrition JSON had no total request-byte cap. These paths could consume substantially more memory than the intended input limits before validation rejected the request.

This change counts actual streamed bytes before multipart or JSON parsing. It starts cancellation on oversized or failed streams, releases the reader, and does not wait for an uncooperative source's cancellation promise. A declared oversized length can still reject early, but a small declared length never bypasses actual-byte counting.

Independent review found that retaining each source chunk in an array could amplify memory usage even within the payload cap. The final reader discards empty chunks and copies bytes into one buffer that grows on demand up to the cap. It also handles sources that reuse their chunk buffer without corrupting earlier bytes.

| Endpoint | Request-byte cap | Existing validation retained |
|---|---|---|
| `/api/analyze` | 10 MiB + 512 KiB | 10 MiB file, MIME/magic-byte checks, demo/live selection, live authentication |
| `/api/meals/photo` | 11 MiB | Authentication, 10 MiB file, image decoding/pixel limits and EXIF stripping |
| `/api/meals` | 450,000 bytes | Authentication, 150,000 UTF-16 code units after decoding, schema, server nutrition resolution and transaction ownership/version checks |
| `/api/nutrition/resolve` | 150,000 bytes | Food-count/schema validation, existing provider and rate-limit behavior |

The meals byte limit preserves valid Chinese JSON at the existing character limit: a UTF-16 code unit needs at most three UTF-8 bytes. Unsupported/malformed or interrupted request bodies return controlled 400 responses; oversized bodies return 413. No source error detail or body content is returned.

## Validation

Node 24.15.0; tracked dependencies; isolated branch `codex/bounded-api-input-20260926` based on `0e77334`.

- Full lint, typecheck and production build: PASS.
- Unit/integration: 251/251 PASS, 27 files.
- Deterministic nutrition evaluation: 47/47 cases PASS.
- Firestore emulator: 8/8 PASS (Java 21, `demo-kcalcue`, localhost port 8198).
- Chromium E2E: 5/5 PASS at 375 × 812, using synthetic authentication/cloud responses.
- New coverage includes absent/understated lengths, incremental rejection before parsing/provider/writes, exact limits, Chinese UTF-8 compatibility, malformed multipart/JSON, interrupted streams, rejected and never-settling cancellation, and unchanged valid-meal ownership/version behavior.
- Independent review: PASS after a second reviewer reproduced the chunk-metadata issue, reviewed the repair and reran 53 scoped tests plus 6 independently written adversarial tests. Extra tests cover byte-split UTF-8/BOM and multipart, live AbortSignal forwarding, authentication before photo input, failed early cancellation and native malformed-UTF-8 decoding semantics.
- Independent local heap experiment, Node 24.15.0 with explicit GC and a pending stream: 200,000 empty chunks used an extra 42,228,440 heap bytes in the first reader versus 165,608 after repair. For 200,000 one-byte chunks, extra heap fell from 47,027,776 to 178,624 bytes, with a 200,000-byte result buffer. These are synthetic local measurements, not production load results or guarantees about upstream buffering.

A disposable snapshot of the owner's existing uncommitted deployment/evaluation work plus both reliability changes applied cleanly and passed lint, typecheck and 291/291 unit/integration tests. The original checkout was not changed. This compatibility check is separate from each PR's clean-main validation and does not authorize deploying uncommitted source.

## Limits and next gate

This is an application parser bound, not a network ingress limit: it cannot undo buffering already performed by a proxy/runtime or prevent a sender from delivering one oversized chunk. Existing request deadlines/rate limits remain unchanged. No dependency, database schema, authentication policy, production configuration or deployment changed.

R2b remains BLOCKED pending an identified QA-only production login. No production meal or real user data was read or written for this change; no real AI invocation occurred. The broader real-photo journey and physical phone/PWA acceptance are not established by mocked E2E. Review/merge/release remain separate from these local checks.

Final raw local logs: `/private/tmp/kcalcue-api-limits-{unit-final,lint-final,types-final,eval,firestore,e2e-final}.log` (E2E includes a production build); disposable compatibility logs: `/private/tmp/kcalcue-existing-integration-{unit-final,lint-final,types-final,e2e-final}.log`. Independent experiment/scripts: `/private/tmp/kcalcue-api-limits-independent-20260926/`. Committed regression tests provide the durable reproduction.
