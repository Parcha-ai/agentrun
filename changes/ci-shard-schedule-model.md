---
packages: repo
kind: ci
---
The test shards are planned by how `node --test` runs a suite's files: in sorted order, as many at once as its `--test-concurrency` (node's own default, 3 on CI's 4-CPU runners, where a script sets none), each starting when one ends, and no faster than the suite's measured parallelism (now the 90th percentile over the logs, what it keeps up with its slots full, where the median read a shard held up by one late file). The plan modelled a suite as its longest file or its files' total over its parallelism, which cannot tell a 120 s file that sorts first from one that sorts last and starts a minute and a half in: the fourteen `any` shards it read as 184 s each ran 130 s to 224 s on the merge queue. `scripts/ci-timings.json` is refreshed from 15 merge-queue runs.
