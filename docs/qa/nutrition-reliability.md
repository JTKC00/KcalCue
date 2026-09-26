# Nutrition lookup reliability — 2026-09-26

## Problems and behavior

The optional external nutrition lookup previously skipped the trial-account
authorization used by Live analysis. With a nutrition provider configured, an
unresolved ingredient could reach the provider without that check. Local
reference matches, unsupported composite dishes and installations without a
provider key already avoid external requests.

The route now authorizes once before the first remote-eligible lookup, including
cache hits, and returns the existing 401/403/503 error response on failure. The
public local/demo branches remain available. Existing body validation, batch
limit, rate limit, provider timeout and cache remain in place.

HTTP/network/provider failures previously looked like ordinary unsupported
foods. The client now explains the failed supplemental lookup on the affected
unresolved food, retains other successful matches and keeps the draft editable.
It does not add retries or invent nutrition values. Intentional cancellation is
not presented as service failure, and an ordinary successful unknown result
keeps its existing explanation.

Independent review also reproduced a calculation crash after a malformed HTTP
200 match (`includedInTotal: true` without the remaining structure). The client
now validates each response match before calculation, editing or draft storage;
an invalid item receives the same explicit failure explanation without dropping
valid items. The schema validates finite, nonnegative ordered nutrient ranges,
positive unit conversions, profile/source/identity structure and included-match
consistency.

## Regression evidence

- The failure explanation tests failed on the original client before the fix.
- An independent fake-provider/auth harness reproduced unauthenticated remote
  requests on the original route. It uses the actual route/auth/cache logic and
  never calls a real provider or uses production credentials.
- Independent verification passed 37 cases: cold/warm cache authorization,
  invalid/expired/revoked tokens, verified allowlist, configuration failure,
  batch authorization, local-only behavior, failure mapping and response safety.
- The malformed-success desired assertion went RED to GREEN. Its separate
  original calculation-crash reproduction is retained outside the repository.
- Compatibility checks accepted 885 JSON outputs across the 31 reference
  profiles and five units, plus actual USDA adapter outputs for each unit,
  unknown foods and composite foods using a fake upstream response.
- Repository regression tests cover authorization denial with no provider call,
  public local/no-key/composite resolution, partial warning index alignment,
  cancellation, no retry and malformed successful responses reaching calculation.

## Acceptance boundary

All evidence above is source/local synthetic verification. No production
nutrition key, provider billing, live exploitation, deployment or production
acceptance is claimed. The production R2b photo matrix is tracked separately.
No schema migration, Firebase rules, secret, provider configuration, deployment
or merge is part of this change.

Existing in-memory rate limits remain scoped to an instance; durable abuse
controls are a separate follow-up. Unknown foods still require a supported
reference food or later product work for manual nutrition values.
