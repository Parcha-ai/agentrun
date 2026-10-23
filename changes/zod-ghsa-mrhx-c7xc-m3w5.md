---
packages: repo
kind: fix
---
zod 4.6.7 for the workspace, the starter example and the authoring guide's install line (was 4.6.5), past GHSA-mrhx-c7xc-m3w5 (fixed in 4.6.6). The package gate accepts that advisory until 2026-12-01 only for the zod copies `@browserbasehq/stagehand` pins (4.4.3, in every stagehand release through 4.3.0) and `@parcha/pi-browser` keeps in step with it. It also accepts the packages flagged only through those copies (stagehand, pi-browser, the harness). Any other zod copy below 4.6.6 still blocks a release.
