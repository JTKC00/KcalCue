# Container build acceptance

This slice packages the existing Next.js app for a secret-free, synthetic Cloud Run-compatible container build. It does not deploy, provision cloud resources, or prove production authentication or real iPhone photo behavior.

## Build boundary

- The build stage copies only the dependency manifests, Next/TypeScript configuration, `src`, `public`, and the two codec/container smoke scripts. It does not use `COPY . .`.
- `.dockerignore` excludes environment files, build/test output, and JPEG, PNG, WebP, HEIC, and HEIF images outside `public`. `.gcloudignore` is stricter: it allows only the Dockerfile's build inputs plus the Cloud Build config, then excludes image formats within `src`. A local `gcloud meta list-files-for-upload` check confirmed a synthetic root CSV and `src` meal JPG were omitted while source, Cloud Build config and public PWA icons remained. The `public` exception is for deliberate public assets; do not place private meal photos there.
- Public Firebase Web config is passed as build arguments. Admin credentials, OpenAI keys, and real QA photos are never build inputs.

## Validation

Run `npm ci`, `npm run lint`, `npm run typecheck`, and `npm run build` with a supported Node version. For the container, build with the four synthetic `NEXT_PUBLIC_FIREBASE_*` values shown in `.github/workflows/container.yml`; `docker build` checks actual HEVC encode/decode in the builder and in the non-root runtime. The workflow then verifies status, CSP, static assets, PWA files, anonymous meal rejection, and demo analysis without live API calls.

The CI trigger covers application source and public assets as well as Docker, dependency, and Next configuration. A green container check proves only that exact PR head and synthetic configuration. Real login, upload, AI analysis, persistence, and device HEIC acceptance require separate QA.

Cloud Build configuration is a source artifact for a later authorized release. Do not run it against a paid project without release approval.
