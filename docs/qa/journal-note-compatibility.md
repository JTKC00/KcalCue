# Journal note compatibility bridge

J1a adds the storage and synchronization contract for future meal journal notes without exposing a note editor yet.

## Record contract

The optional command field is `journalNote?: string | null`.

- Strings normalize CRLF / CR to LF and trim leading/trailing whitespace.
- Whitespace-only input becomes `null`.
- Notes are plain text data. HTML-looking content is not markup.
- The maximum is 500 Unicode code points; over-limit commands fail validation and are not truncated.
- Omission means the writer did not edit the note and must preserve the stored value.
- Explicit `null` clears the note.
- Legacy records with no field continue to read as having no note.

The client keeps omission distinct from explicit null in drafts and queued jobs. A legacy queued edit therefore cannot erase a note learned from the confirmed cloud record, while an explicit queued null can clear it.

## Schema and rollback floor

Meal schema 5 remains the protected nullable-portion schema. Journal-aware writes use schema 6.

Schema 6 requires explicit canonical `journalNote` and `photoRef` fields. The server accepts known older schemas but does not allow a note to be smuggled into those versions. Unknown future schemas remain fail-closed.

A schema-5 meal is upgraded to schema 6 only when it is actually written. There is no collection-wide migration or read-time backfill.

After journal-note UI is enabled in a later release, a rollback target that needs to keep meal editing available must understand schema 6. A pre-J1a writer may remain useful as an emergency traffic target only if operators accept that schema-6 meal writes/deletes will fail closed; it must not be described as a fully functional rollback.

## Existing data invariants

A note-only edit:

- does not change the original AI analysis, original items or analysis provenance;
- preserves an existing valid manual calorie correction because food content is unchanged;
- reuses the existing nutrition matches and does not reserve or call external nutrition lookup solely because the note changed;
- changes the meal command fingerprint, so the same mutation ID cannot silently represent different note content.

The journal note is not sent to the vision provider, an AI prompt, a nutrition lookup, a URL, or diagnostic telemetry by this bridge.

## Release boundary

J1a is compatibility infrastructure only.

It does not add:
- a note textarea or other note UI;
- History search;
- statistics / Insights;
- photo retention;
- billing or public signup;
- provider/model changes.

No production deployment or data migration is part of the source change. A compatibility release requires separate owner authorization and acceptance before a later UI can write notes.
