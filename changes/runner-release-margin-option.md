---
packages: @parcha/agentrun-serve
kind: feature
---
`startRunner` takes `releaseMarginMs`, the margin a claim's tool hosts get beyond the provider's cleanup bound to let a run go, which is also the time a release's cut gets to book what it could not let go and the time a runner's close gives a lost create's recovery to book its release. It defaults to `RELEASE_MARGIN_MS` (5 s), so a runner that does not set it behaves as before. A run in a process of its own gets the runner's margin too. `releaseBoundMs` and `runnerStopBy` take the margin as an optional last argument. A runner's close keeps the longer of its stop margin and its release margin at the end of its window, after the loops' release is cut, so a cut's booking that takes most of the release margin still lands while the claim is renewed (with the defaults, 5 s each, the window is unchanged). A `releaseMarginMs` that is not a finite number of ms, 0 or more, is refused with a `RangeError`.
