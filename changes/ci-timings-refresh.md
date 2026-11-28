---
packages: repo
kind: ci
---
CI's test shards are balanced on current timings: `scripts/ci-timings.json` is rewritten from 285 shard logs of 15 merge-queue runs, and covers the 125 serve test files it was missing.
The slowest tests (redact-contract, key-refusal, key-refusal-sequence-parity) were modelled at seconds and took minutes, so the `any` shards ran 131 s to 291 s (median of 15 runs) against a plan of 162 s each. The old plan's shards modelled on the new weights span 146 s to 266 s; the new plan's span 182 s to 184 s.
