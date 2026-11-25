---
packages: repo
kind: ci
---
The repository installs with pnpm 12.22.0 (package.json's `packageManager`) instead of npm workspaces: `pnpm install --frozen-lockfile` replaces `npm ci`, `pnpm-lock.yaml` and `apps/console/pnpm-lock.yaml` replace the two `package-lock.json` files, and CI, the server's image and the source check install with it. `node_modules` is laid out as npm laid it out (`nodeLinker: hoisted`) and every file is a hard link into pnpm's one store, so a second checkout costs links instead of another copy of the tree. The published packages do not change: their manifests name each other at exact versions, never `workspace:`, and they are still packed and published with npm. `docs/dependencies.md` now reads licenses from `scripts/dependency-licenses.json`, since pnpm's lockfile records none; `node scripts/export-source.mjs --licenses` records the ones a dependency change adds.
