# J1b — Journal-first UI

J1b exposes the journal-note storage contract introduced by J1a and changes the meal-entry emphasis from photo-first to journal-first.

## Entry contract

Manual logging is the primary action from Today, History and the bottom Add navigation.

AI photo analysis remains available as a separate secondary action. Entering manual mode creates an editable food row immediately and does not call the AI analysis endpoint.

The AI flow itself is unchanged: users who choose the photo action still get the existing photo selection, analysis, correction and save journey.

## Meal note UI

The editor exposes `journalNote` as an optional multiline plain-text field.

- The UI uses the same normalization/counting contract as J1a.
- CRLF/CR normalize to LF and outer whitespace is excluded from the limit.
- The limit is 500 Unicode code points, so an emoji counts as one code point.
- The field can temporarily contain more than 500 code points so the user can edit it back down.
- Over-limit input shows an inline alert and disables Save; it is never silently truncated.
- Whitespace-only content is accepted in the editor and becomes `null` through the existing J1a save contract.
- Notes never alter food identity, portions, kcal or macros. Structured meal fields remain the nutrition authority.

A note-only edit keeps the existing manual calorie correction, original AI analysis, original items and provenance. J1a remains responsible for preventing note-only edits from causing paid nutrition lookup work.

## Readback

Non-empty notes are rendered in Today and History beneath the confirmed meal name and above the calorie line.

Notes use text nodes with preserved line breaks. HTML-looking text is displayed literally and is never rendered as markup. Notes are separate from original AI provenance.

Legacy records without `journalNote` show no placeholder and open the editor with a blank optional field.

## Draft, sync and privacy behavior

Journal-note changes travel with the existing account-scoped draft cache and meal outbox.

Verified UI journeys cover:

- note draft write and restore after remount;
- blocked save retaining the edited note;
- explicit clear through the normal save path;
- cloud acknowledgement returning the note to Today;
- Today/History reload readback;
- account switch hiding the previous account's note.

No second journal store or note-specific cloud collection is introduced.

## Release / rollback floor

J1b must not be deployed before the J1a compatibility bridge.

The currently deployed J1a production revision is the minimum functional rollback floor once J1b is released, because a pre-J1a writer does not understand protected meal schema 6.

J1b itself does not deploy anything and does not enable persistent photo Storage, billing, public signup, Insights/statistics or AI journal summaries.

## Local validation target

Before merge:

- focused MealJournal tests;
- lint;
- typecheck;
- full unit/integration suite;
- production build;
- full Playwright journal suite at the configured 375×812 viewport.

Production rollout and hosted authenticated acceptance require a separate owner gate.
