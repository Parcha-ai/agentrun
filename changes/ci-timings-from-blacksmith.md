---
packages: repo
kind: ci
---
CI balances its test shards with times measured on the Blacksmith runners that run them (the merge queue and this repository's own pull requests), not on GitHub's: measured there, the same sixteen `any` shards took 62 s to 257 s. `scripts/ci-timings.json` is refreshed from merge-queue job logs, the `any` pool has fourteen shards, and a shard over its model warns that the timings are stale only on Blacksmith.
