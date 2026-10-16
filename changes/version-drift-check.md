---
packages: repo
kind: ci
---
A check that fails when a user-facing install line names a version other than the current release, a Pi range other than the packages' own, or a bare `npx agentrun`. `scripts/version-drift.mjs` reads only install and version statements, by a structural rule it names (fenced shell commands, inline command spans, the release and Pi range statements, an example's `package.json`), so history, recorded fixtures and minimums are left alone; `scripts/version-drift.test.mjs` runs it in the existing `test:release` job.
