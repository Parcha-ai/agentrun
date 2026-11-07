---
packages: @parcha/agentrun-computer
kind: fix
---
`checkActions()` counts every duration toward a batch's 300 s cap (`MAX_BATCH_WAIT_MS`): the `ms` of a `long_press`, a `swipe` or a `pinch` as well as `wait` and `hold`, so `[{ type: "long_press", ms: 2 ** 52 }]` is refused as `limit`. A `key` action's `repeat` is at most `MAX_KEY_REPEAT` (100). The conformance suite's screenshot reader refuses a shot whose size is over `MAX_PNG_BYTES`, the largest PNG it decodes, before reading it, so a provider cannot make it hold more.
