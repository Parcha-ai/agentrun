---
packages: repo
kind: fix
---
The repository's `npm run build` builds the console (`apps/console`) before the packages, so a fresh checkout's `npm ci && npm run build` gives a server that serves its console, not the "built without its console" page, and so does a release's build. It installs the console's dependencies when they are missing or its lockfile changed, and skips the build when `apps/console/dist` was built from the same sources (a hash of them, written beside the build, never file times). The console's own `npm run build` records that hash, so building it first, as CI and the image do, is not built twice.
