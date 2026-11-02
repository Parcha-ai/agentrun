---
packages: repo
kind: ci
---
**A CI test that hangs fails by name, and a suite that never exits is killed, both before the test job's 30-minute limit**
- `scripts/ci-shard.mjs` adds `--test-timeout` (10 minutes) to each test script of the shape `node --test [--test-concurrency=<n>] <files>`, and to the examples shards. On Node 24 a test still running then fails, named in the log; Node 22 applies the flag to each test file instead, and names the file. A test's own `timeout` holds on Node 24.
- The scripts that run without it are pinned in `ci-shard.mjs` by their text: pi-durable-disk's (its own `--test-timeout`), pi-transport's vitest, pi-browser's and pi-vision's own runners, and `test:viewer`. A test script of any other shape fails its shard, naming the script, before anything runs.
- A shard's suites get 24 minutes in all. The suite still running then is killed with every process it started, the suites after it are not run, and an `::error::` line names each. The job ends failed with its log, where a stalled shard used to be cancelled at 30 minutes, its log sometimes lost.
- `CI_SHARD_TEST_TIMEOUT_MS` and `CI_SHARD_TIMEOUT_MS` set the two limits, in milliseconds.
