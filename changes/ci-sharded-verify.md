---
packages: repo
kind: ci
---
`verify (<node>)` runs its suites as ten shards at once (`scripts/ci-shard.mjs`) and passes when every shard passed; the required check names are unchanged. Pushes run CI on `main` only (a pull request's branch runs on `pull_request`), and a new push to a pull request cancels its running checks.
