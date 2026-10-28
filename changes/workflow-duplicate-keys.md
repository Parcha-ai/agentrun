---
packages: repo
kind: ci
---
A GitHub workflow with a key twice in one map (two `env:` under a job, say), or one that doesn't parse, now fails the release tests, naming the file, line and column. YAML loaders differ on a duplicate key: GitHub's keeps one of the two without a word. `node scripts/check-workflows.mjs [directory]` runs the same check by hand.
