# Container build acceptance

This slice packages the existing Next.js app for a secret-free, synthetic Cloud Run-compatible container build. It does not deploy, provision cloud resources, or prove production authentication or real iPhone photo behavior.

## Build boundary

- The build stage copies only the dependency manifests, Next/TypeScript configuration, `src`, `public`, and the two codec/container smoke scripts. It does not use `COPY . .`.
- Both ignore files use an explicit build-input allowlist. `src` admits only TypeScript/TSX/CSS files; `public` admits each committed file by name (the four PWA icons and the two self-hosted Barlow Condensed fonts under `public/fonts/`); `scripts` admits only the codec and smoke scripts. `.gcloudignore` also admits the Cloud Build config. Container CI injects synthetic private files (nested `.env`, key JSON, GIF/JPG, extra script, public JPG) and checks they stay out. It probes two contexts: the local Docker context, and the Cloud Build path, where `gcloud meta list-files-for-upload` applies `.gcloudignore` first and the pinned Cloud Build Docker 20.10 client then applies `.dockerignore`. Both probes require every file in `git ls-files public`, so a new public asset that is not added to both allowlists fails CI instead of returning 404 after release. Never put private meal data in source files.
- Public Firebase Web config is passed as build arguments. Admin credentials, OpenAI keys, and real QA photos are never build inputs.

## Validation

The codec stage pins libvips **8.18.7** and verifies the official release archive's
SHA256 (`5baaead3b0bb20ffdb9e9ff09aa9fda08620923df77b63b436654cb5e0b3bf94`).
Sharp 0.35.5 requires libvips >=8.18.7; the previous 8.18.6 pin cannot build that
native binding. `container-codecs.test.ts` checks the Docker pin against the
installed Sharp manifest so a dependency update cannot silently raise that floor.
The custom libvips build still enables libheif with libde265/x265, and Sharp still
builds against this global library. Keep both the builder and non-root runtime
HEVC encode/decode checks; prebuilt Sharp's codec set is not a substitute.

Run `npm ci`, `npm run lint`, `npm run typecheck`, and `npm run build` with a supported Node version. For the container, build with the four synthetic `NEXT_PUBLIC_FIREBASE_*` values shown in `.github/workflows/container.yml`; `docker build` checks actual HEVC encode/decode in the builder and in the non-root runtime. The workflow then verifies status, CSP, static assets, every self-hosted font referenced by the built CSS (200, `font/woff2`, non-empty), PWA files, anonymous meal rejection, and demo analysis without live API calls.

The CI trigger covers application source and public assets as well as Docker, dependency, and Next configuration. A green container check proves only that exact PR head and synthetic configuration. Real login, upload, AI analysis, persistence, and device HEIC acceptance require separate QA.

Cloud Build configuration is a source artifact for a later authorized release. Do not run it against a paid project without release approval.
