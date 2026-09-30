# Full meal-list read telemetry

Issue [#89](https://github.com/JTKC00/KcalCue/issues/89) remains open. A legacy unpaged GET and a paged GET for an imported account without revision metadata both read the full active meal collection. Capping either response without a compatible migration could silently remove meals from Today and History.

When either full-query fallback runs, the server emits one best-effort `[kcalcue:meal-full-read]` event. Its only fields are `mode` (`legacy_revisioned`, `legacy_revisionless`, or `paged_revisionless`), `querySucceeded`, `activeRecordCount` (null if the query failed), and `elapsedMs`. It does not emit UID, email, revision, cursor, request URL, meal content, or raw errors. A logging failure cannot fail the GET or cause another full query.

After an approved release, aggregate counts by mode and active-record-count bands to gauge request volume and response-size exposure. This anonymous event **cannot measure distinct accounts, identify client versions, or prove revisionless account prevalence**. Those questions require a separately reviewed, privacy-safe inventory before migration. Compare the rollout window against baseline traffic; keep the legacy and revisionless fallbacks until compatibility, QA-account acceptance, indexes, and migration gates in #89 are met. No production migration or read cap is enabled by this change.
