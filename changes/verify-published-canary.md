---
packages: repo
kind: ci
---
Groundwork for a canary from main, published under npm's `canary` dist-tag. No workflow publishes one yet.
`scripts/canary.mjs versions <run> <sha>` sets every release package to its canary version, and every exact pin between them. `x.y.z` becomes `x.y.(z+1)-canary.<run>.g<sha7>` and `x.y.z-beta.N` becomes `x.y.z-canary.<run>.g<sha7>`. It refuses a tree that is already a canary.
`scripts/canary.mjs plan <sha>` writes `.release/release-plan.json` from the archives `verify:packages` verified. It checks the bytes, the commit the versions name, and that the verification passed.
`scripts/verify-published.mjs` takes `--canary`. With it, every package of the plan must be `<x.y.z>-canary.<run>.g<sha>`, all on one suffix, and a release plan is refused. Without it, nothing changes and a canary plan is refused. An unknown or repeated flag stops at the usage line before any registry read.
