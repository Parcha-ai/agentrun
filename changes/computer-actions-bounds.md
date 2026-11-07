---
packages: @parcha/agentrun-computer
kind: fix
---
`checkActions()` counts every duration toward a batch's 300 s cap (`MAX_BATCH_WAIT_MS`): the `ms` of a `long_press`, a `swipe` or a `pinch` as well as `wait` and `hold`, so `[{ type: "long_press", ms: 2 ** 52 }]` is refused as `limit`. A `key` action's `repeat` is at most `MAX_KEY_REPEAT` (100). The conformance suite's screenshot reader refuses a shot whose size is over `MAX_PNG_BYTES`, the largest PNG it decodes, before reading it, so a provider cannot make it hold more.

Refusal-side conformance cases now pass only on the refusal they test. `drift.version` needs the drift check's own words (`hello: the daemon reports version X, expected Y`, two different versions) in the create or connect refusal; a create refused for another reason (a network mismatch, a vendor error that mentions a version) fails it. `provider.check-refuses` and the other refused creates need `check()`'s words in create's refusal; a connect to a deleted computer or one past its deadline must answer `gone` or `not_found`; an attach by labels two computers match must answer `invalid`.
