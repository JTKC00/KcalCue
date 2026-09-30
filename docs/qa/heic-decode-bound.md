# HEIC/HEIF decode bound

The AI preparation path now explicitly uses Sharp's 40,000,000 input-pixel bound, matching the existing photo preparation route. Previously it used Sharp's substantially larger default. Oversized inputs fail with `image_rejected` before the AI SDK is called. Rotation, JPEG conversion, retry policy, and the direct JPEG/PNG/WebP path are unchanged.

This intentionally rejects images above 40M pixels, including 48MP originals. It does not resize those images or establish a hard CPU/RSS spending cap. Native HEIC codec and physical-device acceptance remain release checks.

Validation on 2026-09-26: 272 full unit tests, lint, typecheck and build passed. Independent review ran 70 scoped tests and 9 additional probes: real Sharp oversized rejection before SDK, HTTP 422 classification, unchanged direct-format bytes, and rotation/EXIF behavior. Boundary fixtures exercise image headers and conversion branches, not a native 40M HEIC decode. The owner-compatible integration passed 74 scoped tests while preserving execution hooks. Browser integration is tracked separately in the session QA handoff.

No deployment, cloud configuration or production data changes are included. This slice is stacked on the live-analysis cost-guard branch.
