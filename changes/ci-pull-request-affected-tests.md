---
packages: repo
kind: ci
---
On a pull request, CI's `any` test shards run only the test files the pull request's changes reach (`scripts/ci-affected.mjs`, using the same selection as `npm run test:affected`), shared out across the shards by time. They run every test when a shared root changes (the root manifests, the lockfile, `scripts/`, `.github/`), and every test of a package with a changed file that no test imports or names (a Go source, a SQL migration). The `lean` shards, the merge queue and `main` still run every test, so a test the selection misses fails in the merge queue rather than on `main`. Each shard's log lists what every changed path picked.
