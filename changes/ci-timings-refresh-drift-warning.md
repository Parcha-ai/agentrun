---
packages: repo
kind: ci
---
The test shards' weights (`scripts/ci-timings.json`) are refreshed from 168 job logs of three green pull-request runs; the old ones dated from the day sharding landed. The root scripts suite had grown (`release-preflight.test.mjs` alone went from 152 s to 257 s), and all of it sat on `any-2`, which then ran 7.8 min against the other `any` shards' 5.4 to 6.1 and held up `lean` and `verify` in 36 of 40 runs. Each shard now prints `ci-shard: <shard> ran <s> s, modelled <s> s` and, when it ran more than a quarter and more than a minute over its model, a `::warning` that the weights are stale, with the command that refreshes them.
