---
packages: repo
kind: ci
---
The validator sweep collector (`spec/lean/sweep/collect.mjs`) takes `--test-concurrency <n>`, or `TEST_CONCURRENCY=<n>`, and passes it to the DSL, Pi and example suites it runs. With neither set, node's default is unchanged.
