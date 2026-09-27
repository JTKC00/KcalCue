# Container build acceptance

This slice packages the existing Next.js app for a secret-free, synthetic Cloud Run-compatible container build. It does not deploy, provision cloud resources, or prove production authentication or real iPhone photo behavior.

## Build boundary

- The build stage copies only the dependency manifests, Next/TypeScript configuration, `src`, `public`, and the two codec/container smoke scripts. It does not use `COPY . .`.
- Both ignore files use an explicit build-input allowlist. `src` admits only TypeScript/TSX/CSS files; `public` admits only the four committed PWA icons; `scripts` admits only the codec and smoke scripts. `.gcloudignore` also admits the Cloud Build config. A local `gcloud meta list-files-for-upload` probe confirmed all current source and required build files are included, while synthetic nested `.env`, key JSON, GIF/JPG, root CSV, extra script and public JPG are excluded. Container CI separately injects synthetic private files and probes the actual Docker context before the full build. New source extensions or public assets require an explicit allowlist update. Never put private meal data in source files.
- Public Firebase Web config is passed as build arguments. Admin credentials, OpenAI keys, and real QA photos are never build inputs.

## Validation

Run `npm ci`, `npm run lint`, `npm run typecheck`, and `npm run build` with a supported Node version. For the container, build with the four synthetic `NEXT_PUBLIC_FIREBASE_*` values shown in `.github/workflows/container.yml`; `docker build` checks actual HEVC encode/decode in the builder and in the non-root runtime. The workflow then verifies status, CSP, static assets, PWA files, anonymous meal rejection, and demo analysis without live API calls.

The CI trigger covers application source and public assets as well as Docker, dependency, and Next configuration. A green container check proves only that exact PR head and synthetic configuration. Real login, upload, AI analysis, persistence, and device HEIC acceptance require separate QA.

Cloud Build configuration is a source artifact for a later authorized release. Do not run it against a paid project without release approval.
