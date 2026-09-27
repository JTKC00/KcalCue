# Cloud Run private-trial release guard

This PR adds source tooling only. It does not run Cloud Build, change a Cloud Run service, modify Firebase, or authorize a production release. The CLI requires an explicit private config outside the repository, a project labelled `kcalcue=private-trial`, and a separately authenticated `gcloud` operator. The checked-in example contains placeholders only.

`npm run trial:cloud -- preflight --config /absolute/private/config.json` is read-only. `build`, `deploy`, `pause`, `resume`, and `rollback` are live mutations and require a separate authorized release decision. Do not run them from CI. The release operator must verify the exact merged source tree, image digest, build-time Firebase web config, current service/account allowlist, analysis switch, and previous revision before a deployment. Keep rollback and QA acceptance evidence with that release.

## Source safety properties

- An existing service must have the expected Firebase project, the same account allowlist as the private config, and an explicit `true` or `false` analysis switch. Missing or unexpected state stops before `run deploy`; this prevents a stale two-account config from silently removing a QA account or an unknown switch from being changed without review.
- Existing deployments use `--update-env-vars` and `--update-secrets`. Local `gcloud run deploy --help` states `--env-vars-file` removes all existing variables; the first deployment alone may use it because there is no environment to preserve.
- Deploy/pause/resume create a revision with `--no-traffic`, verify its account list, project, analysis switch, and Ready state, then explicitly route 100% and read back the serving traffic. Rollback first checks both the currently serving and target revisions against the expected project/account list, plus the target's explicit analysis switch and Ready condition, before moving traffic; it then reads back Ready 100% traffic before reporting PASS. This cannot prove that an older application writer is schema-compatible, so the operator must separately verify the target image and migration/rollback plan. Any uncertain failure stops; the CLI does not retry.
- The first service deployment starts with analysis paused. Existing deployments preserve the current analysis switch and other runtime environment/secret entries. Changing the allowlist is intentionally a separate reviewed operation.

Fake-`gcloud` tests cover new/existing services, preserving the allowlist and secret/env update modes, no-traffic routing, switch mismatch, rollback readback, and project/auth-domain guards. These tests do not prove current production IAM, secret state, Cloud Run API responses, or a real release. No live mutation was run for this PR.
