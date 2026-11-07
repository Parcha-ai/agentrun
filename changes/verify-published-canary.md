---
packages: repo
kind: ci
---
`scripts/verify-published.mjs` takes `--canary`, for a canary built from main and published under npm's `canary` dist-tag. With it, every package of the plan must be `<x.y.z>-canary.<run>.g<sha>`, with the same suffix on every package, and a release plan is refused. Without it, nothing changes: `@parcha/agentrun` is `x.y.z`, every other package `x.y.z-beta.N`, and a canary plan is refused. An unknown or repeated flag stops at the usage line before any registry read. No workflow publishes a canary yet.
