# Cloud Run private-trial release guard

This change is source tooling only. It does not run Cloud Build, create a Cloud Run revision, change traffic, modify Firebase, or authorize a production release. The CLI requires an explicit private config outside the repository, a project labelled `kcalcue=private-trial`, and a separately authenticated `gcloud` operator. The checked-in example contains placeholders only.

`deploy` is rejected before any `gcloud` call. It no longer creates a revision and then sends production traffic to it. Use the split sequence below. Do not run live mutations from CI.

## Release sequence

1. `npm run trial:cloud -- preflight --config /absolute/private/config.json`  
   Read-only check of the project label, billing, required APIs, the selected OpenAI secret version, and, when `nutritionSecretVersion` is set, that `kcalcue-nutrition` version. A missing or non-`ENABLED` nutrition version stops preflight.
2. `npm run trial:cloud -- build --config /absolute/private/config.json --tag <immutable-tag>`  
   Submits Cloud Build for that tag. `latest` is rejected.
3. `npm run trial:cloud -- stage --config /absolute/private/config.json --tag <verified-tag> --smoke-tag <cloud-run-tag>`  
   Creates one candidate revision at zero normal production traffic and assigns the explicit Cloud Run traffic tag. `stage` does not call `update-traffic`. The smoke tag must be supplied; it is not derived from the image tag. It must be a lowercase Cloud Run tag: it starts with a letter, contains only letters, numbers, and hyphens, does not end with a hyphen, and is at most 63 characters. `latest` is rejected. Malformed tags fail before any `gcloud` call.
4. Hosted smoke on the tagged URL printed by `stage`. That URL reaches the candidate only. The candidate still has 0% normal production traffic, and the previous production revision still has 100%. A traffic tag is not promotion authorization.
5. Explicit owner approval of that exact revision.
6. `npm run trial:cloud -- promote --config /absolute/private/config.json --revision <candidate-revision>`  
   Re-reads the named candidate and the current single production revision. Only then moves production traffic to the candidate at 100% and reads the service back. `promote` does not accept a tag as the revision identity, and it does not remove the smoke tag.
7. Production smoke.
8. `npm run trial:cloud -- untag --config /absolute/private/config.json --tag <smoke-tag>`  
   Removes only that temporary tag with `--remove-tags` and no percentage flags. It reads the service back and requires the same revision to remain at 100%. It does not delete revisions.
9. `npm run trial:cloud -- rollback --config /absolute/private/config.json --revision <previous-revision>` if the smoke fails.

After `stage` creates the candidate, the CLI reads that revision and the service traffic back. Success requires the previous checks plus all of the following: the previous production revision is still the only revision at 100% normal traffic, or the service is new and nothing has normal traffic; the candidate has 0% normal traffic; exactly one traffic entry uses the requested smoke tag and it names the candidate; no other revision uses that tag; and the entry URL is exactly the origin formed by prefixing `<smoke-tag>---` to the hostname of this service's `status.url`. That hostname's Cloud Run service identifier is opaque and is not parsed for region or project. Other tags are ignored. If any of this cannot be proven, `stage` stops without `update-traffic`. The unverified revision and tag may remain for `untag`; the CLI does not delete revisions as error recovery.

## Allowlist-only transition

`access-stage` and `access-promote` change only `KCALCUE_ALLOWED_EMAILS`. They do not build an image. `access-stage` reads the single Ready revision at 100%, reuses that exact digest-pinned image, and creates a zero-traffic candidate with an explicit `--smoke-tag`. The private config's allowlist may add or remove accounts. Comparison is case-insensitive and order-independent; if the target set is already the serving set, `access-stage` refuses the no-op before deploy. Firebase settings, the analysis switch, `KCALCUE_VISION_PROVIDER=openai`, `OPENAI_MODEL=gpt-5.6-luna`, the complete declared environment/secret shape, and the approved Cloud Run execution contract must already match production. The access path also verifies the serving and candidate revisions keep the same service account, port, CPU/memory, concurrency, timeout, revision min/max instances, CPU throttling and startup CPU boost. It does not pass service-level `--min`/`--max` or `--allow-unauthenticated`, so an allowlist transition does not intentionally mutate service-level scaling or IAM. `access-promote --revision <candidate>` is the only promotion that allows the current serving allowlist to differ from the private config. The candidate allowlist must equal that config and its execution contract must match the serving revision before traffic can move. Keep the previous production revision for rollback. Do not put real account addresses in the repository; the private config stays outside git. Placeholder shape: `owner@example.com` and `added-user@example.com`.

`pause` and `resume` are not release steps. They still publish an analysis-switch revision at 100% after checks. They are safe to keep only because they no longer inherit the service template: they pin `--image` to the currently serving revision's digest, replace the full environment and secret set, and verify the new revision before `update-traffic`.

## Production configuration

RC1 production remains OpenAI:

- `KCALCUE_VISION_PROVIDER=openai`
- `OPENAI_MODEL=gpt-5.6-luna`
- required secret mapping `OPENAI_API_KEY=kcalcue-openai:<openaiSecretVersion>`

`openaiSecretVersion` stays required. Optional `nutritionSecretVersion` is the only way to keep the USDA FoodData Central fallback. `getNutritionApiKey()` reads `NUTRITION_API_KEY`. When the field is set, the production secret set is exactly:

- `OPENAI_API_KEY=kcalcue-openai:<openaiSecretVersion>`
- `NUTRITION_API_KEY=kcalcue-nutrition:<nutritionSecretVersion>`

When the field is omitted, the production secret set is exactly the OpenAI mapping. The secret name is the fixed reviewed name `kcalcue-nutrition`. Gemini secrets stay forbidden. Any other secret stays forbidden. The same declared set is what `stage`, `promote`, `pause`, `resume`, and `rollback` write or accept.

Gemini stays RC-only. A candidate must not contain `GEMINI_MODEL` or a `GEMINI_API_KEY` secret mapping. `stage` does not inherit the service template. Local `gcloud run deploy --help` states that `--env-vars-file` removes every existing environment variable before adding the file, and `--set-secrets` removes every existing secret before adding the listed mapping. `stage` always passes both, including for an existing service. The file sets the Firebase web config, the account allowlist, the approved analysis switch, `OPENAI_MODEL=gpt-5.6-luna`, and `KCALCUE_VISION_PROVIDER=openai`. No Gemini key is written. Secret values are never accepted on the command line or printed. Full replacement still applies: an undeclared template secret, including a previously mounted nutrition secret, is removed rather than copied.

The approved analysis switch is read from the revision that currently serves 100%, not from the service template. The first service starts paused (`KCALCUE_ANALYSIS_ENABLED=false`). If that serving revision's Firebase project or account allowlist differs from the private config, or its analysis switch is not exactly `true` or `false`, `stage` stops before `run deploy`.

## Fail-closed checks

After `stage` creates the candidate, the CLI reads that revision back and stops without `update-traffic` unless all of the following are true:

- the image is the immutable Artifact Registry digest just resolved for the tag. `container.image` must be `asia-east1-docker.pkg.dev/<project>/kcalcue/web@sha256:<64 lowercase hex>`. When `status.imageDigest` is present, Cloud Run may report either that bare `sha256:` digest or the same full digest-pinned reference. The guard normalizes only those two forms for this exact repository, then requires the digests to be equal. A missing `status.imageDigest` stays acceptable when `container.image` already proves that identity. Any other reported form fails closed.
- the revision is Ready;
- the Firebase project and account allowlist match the private config;
- `KCALCUE_ANALYSIS_ENABLED` matches the approved production switch;
- `KCALCUE_VISION_PROVIDER=openai` and `OPENAI_MODEL=gpt-5.6-luna`;
- Gemini model and Gemini secret configuration are absent, and the revision secret set equals the declared production set above;
- production traffic is still entirely on the pre-stage revision at 100%, or the service is new and nothing is serving;
- the candidate has no normal production traffic;
- the requested smoke tag points only to that candidate, and its URL equals `https://<smoke-tag>---<hostname>` derived from `service.status.url`. The base URL must be HTTPS, have no credentials, query, or fragment, use an empty or `/` path, end in `.run.app`, and must not itself be a tagged URL.

`promote --revision <candidate>` repeats the candidate checks before changing traffic. It does not treat a smoke tag as the candidate identity. It also requires the current service to have exactly one revision at 100%. The candidate image must be a digest-pinned image in this project's `kcalcue/web` repository; `promote` has no image tag, so it cannot re-check a caller-supplied digest. It then sets that revision to 100% and reads the service back. Success requires that revision at 100% and service Ready. Any uncertain read stops before `update-traffic`. The smoke tag remains until an explicit `untag`.

`untag --tag <smoke-tag>` first requires one revision at 100% and exactly one entry for that tag. It then runs `update-traffic --remove-tags=<smoke-tag>` without `--to-revisions`, `--to-tags`, or `--to-latest`. Readback must show the tag gone, every other tag unchanged, and the same revision still at 100%. It does not delete the revision. A missing, duplicate, or traffic-bearing tag stops before that call.

`rollback --revision <previous-revision>` still requires an explicit revision, a known single current production revision, and matching current project and allowlist. The target must be Ready and match the project, allowlist, and an explicit analysis switch before traffic moves. The CLI then reads back 100% traffic. Rollback also rejects Gemini configuration, a non-`openai` provider, a missing or different OpenAI model, a secret set that differs from the declared production contract, and an image that is not an immutable project digest. A target may omit `KCALCUE_VISION_PROVIDER` because revisions created before this split did not set it; if the variable is present it must be `openai`. Rollback does not require the current serving revision to be free of Gemini, so it can move traffic off a contaminated revision onto a previously verified target.

Fake-`gcloud` tests cover a Gemini-contaminated service template, zero-traffic stage with a smoke tag and tagged URL, rejection of a bad tag, wrong tag target, missing URL, candidate traffic, and unrelated tags, explicit tag cleanup, the declared OpenAI-only and OpenAI-plus-nutrition secret sets, undeclared or wrong nutrition secrets, preflight of the optional nutrition version, explicit promote and readback, retired `deploy`, and the existing rollback guards. These tests do not prove current production IAM, secret state, Cloud Run API responses, or a real release. No live build, stage, promote, untag, rollback, pause, or resume was run for this change.
