# Analysis execution provenance

The analysis response carries optional execution metadata separately from FoodAnalysis. After valid analysis parsing, the provider reports its identity, requested model, response-reported model if available, application pipeline version and execution timestamp. `modelVersion` remains null: model names and SDK versions are not evidence of immutable model weights.

`food-vision-v1` identifies the application analysis contract. Change it deliberately when the prompt, schema or processing contract changes. It is not a nutrition database version or a guarantee of calorie accuracy. AI food/portion analysis and user-corrected final calories remain separate.

The client validates optional metadata without rejecting otherwise valid analysis. Persisted metadata always has `source: "client-reported"`; it is not a server receipt, entitlement, billing proof or attestation. Unknown extra trust claims cannot upgrade it. Manual meals and legacy missing data stay null. Do not backfill old records from current environment settings.

First-save metadata belongs to the immutable original analysis. Subsequent edits preserve it alongside original items; copying a meal retains its original analysis timestamp. A new analysis on an unsaved draft replaces that draft's analysis baseline. Account/race guards and existing calorie-correction semantics remain. Offline queues retain mutation IDs; omitted and null unknown metadata have equivalent retry fingerprints.

Schema3 makes field preservation explicit. Current writers accept known legacy0/1/2 and3, reject newer schemas before expensive processing and again inside the transaction, and preserve same-mutation acknowledgements. A v2 writer cannot edit v3 records. Active/rollback writers must preserve provenance and correction metadata; pre-schema whole-record writers are unsafe rollback targets. No migration/backfill is required or performed.

Validation is recorded in the PR and session handoff: full unit, real local Firestore emulator, build/E2E and independent source/probe review are separate from live acceptance. This source slice creates no cloud resources and does not change production configuration. The sibling cost-guard and HEIC slices must be integrated without losing the owner's execution hooks; the temporary combined snapshot is evidence, not a deployable release commit.
