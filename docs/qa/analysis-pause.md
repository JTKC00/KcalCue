# Live analysis pause switch

`KCALCUE_ANALYSIS_ENABLED=false` makes authenticated Live `POST /api/analyze` requests return `503` with `error.code: analysis_paused` before calling the vision provider. The default is enabled; no production configuration is changed by this PR. Demo mode remains available, and meal journal reads/writes, manual entry, corrections, and sync use separate routes.

The check follows authentication, so a request without a valid account still receives the usual authorization error. The UI has a localized message explaining that existing records and manual entry remain usable. Re-enabling requires the authorized deployment operator to remove the flag or set it to `true` in a later release; this switch is a cost-control fallback, not a durable per-user quota.

Validation on the source branch: focused route tests (including unauthenticated, paused Live, and Demo cases) 12/12; full unit suite 216/216 on Node 22.23.2; lint, typecheck, and production build passed. Production flag behavior remains unverified until an authorized deployment and acceptance run.
