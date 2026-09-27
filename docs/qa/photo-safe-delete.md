# Future-schema meal deletion guard

The server now checks a stored meal's schema inside the versioned delete transaction, after acknowledging an already committed delete mutation and before writing a tombstone. A writer that does not understand a future meal record returns `409 unsupported_schema` without changing the meal or account revision. Known legacy and current records retain normal deletion and same-mutation retry behavior.

This closes a rollback hazard for planned private History photos: an older writer could previously delete a newer meal without scheduling its image cleanup. The check is deliberately fail-closed. A rollback intended to keep deletion available must include the newer record and asset lifecycle logic; an old revision cannot be treated as a fully functional rollback simply because it can parse a meal ID and version.

The change does not store or delete photos. History photo ownership, private reads, generation-aware object cleanup and an authorized storage resource remain covered by [the separate design PR](https://github.com/JTKC00/KcalCue/pull/22).

Verification: real local Firestore emulator checks the 409 response, unchanged document update time and unchanged account revision for a future-schema meal. Existing emulator checks cover current/legacy deletion, tombstone retry and no resurrection. No production deployment or migration is included.
