---
packages: @parcha/agentrun-serve
kind: feature
---
`startRunner` takes `releaseMarginMs`, the margin a claim's tool hosts get beyond the provider's cleanup bound to let a run go, which is also the time a release's cut gets to book what it could not let go and the time a runner's close gives a lost create's recovery to book its release. It defaults to `RELEASE_MARGIN_MS` (5 s), so a runner that does not set it behaves as before. A run in a process of its own gets the runner's margin too. `releaseBoundMs` and `runnerStopBy` take the margin as an optional last argument.
