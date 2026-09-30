# Cloud Run private-trial release guard

This change is source tooling only. It does not run Cloud Build, create a Cloud Run revision, change traffic, modify Firebase, or authorize a production release. The CLI requires an explicit private config outside the repository, a project labelled `kcalcue=private-trial`, and a separately authenticated `gcloud` operator. The checked-in example contains placeholders only.

`deploy` is rejected before any `gcloud` call. It no longer creates a revision and then sends production traffic to it. Use the split sequence below. Do not run live mutations from CI.

## Release sequence

1. `npm run trial:cloud -- preflight --config /absolute/private/config.json`  
   Read-only check of the project label, billing, required APIs, and the selected OpenAI secret version.
2. `npm run trial:cloud -- build --config /absolute/private/config.json --tag <immutable-tag>`  
   Submits Cloud Build for that tag. `latest` is rejected.
3. `npm run trial:cloud -- stage --config /absolute/private/config.json --tag <verified-tag>`  
   Creates one candidate revision at zero production traffic. `stage` does not call `update-traffic`. The command reports the new revision name and the revision that still serves 100%.
4. Candidate inspection and hosted smoke against that zero-traffic revision.
5. Explicit owner approval of that exact revision.
6. `npm run trial:cloud -- promote --config /absolute/private/config.json --revision <candidate-revision>`  
   Re-reads the named candidate and the current single production revision. Only then moves production traffic to the candidate at 100% and reads the service back.
7. Production smoke.
8. `npm run trial:cloud -- rollback --config /absolute/private/config.json --revision <previous-revision>` if the smoke fails.

`pause` and `resume` are not release steps. They still publish an analysis-switch revision at 100% after checks. They are safe to keep only because they no longer inherit the service template: they pin `--image` to the currently serving revision's digest, replace the full environment and secret set, and verify the new revision before `update-traffic`.

## Production configuration

RC1 production remains OpenAI:

- `KCALCUE_VISION_PROVIDER=openai`
- `OPENAI_MODEL=gpt-5.6-luna`
- secret mapping `OPENAI_API_KEY=kcalcue-openai:<version>`

Gemini stays RC-only. A candidate must not contain `GEMINI_MODEL` or a `GEMINI_API_KEY` secret mapping. `stage` does not inherit the service template. Local `gcloud run deploy --help` states that `--env-vars-file` removes every existing environment variable before adding the file, and `--set-secrets` removes every existing secret before adding the listed mapping. `stage` always passes both, including for an existing service. The file sets the Firebase web config, the account allowlist, the approved analysis switch, `OPENAI_MODEL=gpt-5.6-luna`, and `KCALCUE_VISION_PROVIDER=openai`. No Gemini key is written. Secret values are never accepted on the command line or printed.

The approved analysis switch is read from the revision that currently serves 100%, not from the service template. The first service starts paused (`KCALCUE_ANALYSIS_ENABLED=false`). If that serving revision's Firebase project or account allowlist differs from the private config, or its analysis switch is not exactly `true` or `false`, `stage` stops before `run deploy`.

## Fail-closed checks

After `stage` creates the candidate, the CLI reads that revision back and stops without `update-traffic` unless all of the following are true:

- the image is the immutable Artifact Registry digest just resolved for the tag;
- the revision is Ready;
- the Firebase project and account allowlist match the private config;
- `KCALCUE_ANALYSIS_ENABLED` matches the approved production switch;
- `KCALCUE_VISION_PROVIDER=openai` and `OPENAI_MODEL=gpt-5.6-luna`;
- Gemini model and Gemini secret configuration are absent, and the only secret mapping is `OPENAI_API_KEY` from `kcalcue-openai`;
- production traffic is still entirely on the pre-stage revision at 100%, or the service is new and nothing is serving;
- the candidate has no production traffic.

`promote --revision <candidate>` repeats those candidate checks before changing traffic. It also requires the current service to have exactly one revision at 100%. The candidate image must be a digest-pinned image in this project's `kcalcue/web` repository; `promote` has no tag, so it cannot re-check a caller-supplied digest. It then sets that revision to 100% and reads the service back. Success requires that revision at 100% and service Ready. Any uncertain read stops before `update-traffic`.

`rollback --revision <previous-revision>` still requires an explicit revision, a known single current production revision, and matching current project and allowlist. The target must be Ready and match the project, allowlist, and an explicit analysis switch before traffic moves. The CLI then reads back 100% traffic. Rollback also rejects Gemini configuration, a non-`openai` provider, a missing or different OpenAI model, any secret other than `kcalcue-openai`, and an image that is not an immutable project digest. A target may omit `KCALCUE_VISION_PROVIDER` because revisions created before this split did not set it; if the variable is present it must be `openai`. Rollback does not require the current serving revision to be free of Gemini, so it can move traffic off a contaminated revision onto a previously verified target.

Fake-`gcloud` tests cover a Gemini-contaminated service template, zero-traffic stage, rejection of a candidate that still contains Gemini, explicit promote and readback, retired `deploy`, and the existing rollback guards. These tests do not prove current production IAM, secret state, Cloud Run API responses, or a real release. No live build, stage, promote, rollback, pause, or resume was run for this change.
