# Meal record metadata

This change is stacked on the account/sync fixes in PR #12. It adds two read-only fields without a collection migration or an IndexedDB schema upgrade.

## Contract

- `schemaVersion: 1` describes the meal record envelope. It is independent of optimistic-concurrency `version`, mutation IDs, and any future AI pipeline version.
- `createdAt` is the server's first accepted cloud creation time, encoded as a UTC ISO string. It is not the meal time, photograph time, or analysis time.
- A new document receives one server-clock value for both `createdAt` and `updatedAt` inside the committing transaction. Existing valid creation times survive edits from old and new clients.
- Legacy records with missing or invalid creation times retain unknown history: their next edit writes `createdAt: null`. Reads neither backfill fields nor change account revisions.
- Missing schema versions and versions 0 or 1 are writable. Unknown versions and malformed values fail with `409 unsupported_schema`, before nutrition enrichment and again inside the transaction. The local job remains available for recovery.
- An already accepted mutation returns its saved record unchanged, including its timestamps and schema, without another write or revision change. This acknowledgement remains valid even if a later schema is present.

The command schema strips client-supplied metadata and ownership. The transaction derives metadata from the actual previous document. Existing analysis/original-item preservation, tombstones, version conflicts and UID isolation remain intact. Deletes still remove meal content rather than retaining it for provenance.

## Client compatibility

Existing drafts and caches can carry the optional read-only fields. New offline records have no confirmed creation time. Outbox overlays preserve metadata from a server acknowledgement even when an older queued edit lacks it; editable values still come from the pending job. Outbound commands omit both fields.

Metadata changes do not create a new mutation ID for the same writable draft. Copying a conflicted edit into a new meal clears the original record's metadata. Ordinary edits preserve it. Today and History continue using the user's meal date/time; totals and nutrition coverage do not use `createdAt`.

No historical model identifier, analysis receipt or upload record is invented. Existing `analysis`, `originalItems` and editable `items` stay separate. This envelope version is not proof of a server-executed AI analysis. Photo retention remains unchanged.

## Release and rollback requirement

**Every active backend writer, including any rollback build, must preserve these fields once v1 records can be written.** The previous backend replaces a whole record and can remove `createdAt` and `schemaVersion` during an old-style edit. An independent probe reproduced that loss against the prior writer.

Do not roll back to an arbitrary pre-metadata build after enabling new writes. Prepare a rollback build with the metadata-preserving writer backported, and ensure traffic cannot reach an older writer. Client rollback remains compatible because the server owns the fields. No automatic deployment, production backfill, rules change or production data access is part of this PR.

## Verification

- Node 24.15: 261 unit tests, lint and typecheck pass.
- Real local Firestore emulator: 23 tests pass, including forged metadata, legacy reads/edits, old clients, repeated mutations, concurrent creation, future schemas, tombstones and UID isolation. Local Firebase CLI 15.25.1; CI retains its existing pinned version.
- Independent review: 57 scoped tests plus 13 isolated transaction probes pass. The prior-writer rollback-loss probe is an expected release limitation, not a claimed successful rollback.
- Production build and 6/6 mobile Chromium E2E pass, covering offline creation/edit/reload, conflict recovery, retry, photo privacy and the photo-to-history journey. Browser cloud/auth responses are synthetic; they do not constitute production deployment acceptance. Exact-head CI is recorded separately in the PR.

The broader R2b real-photo acceptance is documented separately. This metadata slice has not been deployed.
