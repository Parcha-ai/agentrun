---
packages: repo
kind: ci
---
CI balances its test shards with times measured on the Blacksmith runners that run them (the merge queue and this repository's own pull requests), not on GitHub's: measured there, the same sixteen `any` shards took 62 s to 257 s. `scripts/ci-timings.json` is refreshed from merge-queue job logs, the `any` pool has fourteen shards, and a shard over its model warns that the timings are stale only on Blacksmith. The lean validator sweep's capture hook now leaves a marker, `reached`, in each lean shard it runs in, and the `lean` job accepts a shard with the marker and no capture: with these weights `lean-1` runs only `decision-provider-mutants.test.mjs`, which validates no workflow. A shard with neither, or one that failed, still fails the sweep, and every suite still needs a capture.
