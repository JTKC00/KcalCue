# Hosting and Email Link source configuration

This PR records the existing KcalCue Firebase Hosting → Cloud Run mapping in source: site `gen-lang-client-0116641325`, service `kcalcue`, region `asia-east1`. It also keeps `/api/**` responses private/no-store at the Hosting edge and directs Email Link callbacks to `https://kcalcue.snugzap.com/` only when both the production Firebase project and branded auth domain are compiled into the client build. Other builds continue using their own origin.

This is **source configuration only**. It does not change DNS, Firebase Hosting, Auth settings, Cloud Run, IAM or production traffic. The repo intentionally does not include a default `.firebaserc` in this slice: any authorized Hosting deployment must name the exact project and `--only hosting` explicitly, then read back the deployed version and run QA login/API acceptance. Do not infer live Hosting state from this file alone.

Risk: a preview built with production Firebase public configuration will send Email Links back to the canonical production origin. That is deliberate to avoid a preview-origin callback and must remain covered by the client test. A production release still requires a separately reviewed container build, compatible runtime configuration and rollback plan.
