---
packages: @parcha/agentrun-serve
kind: breaking
---
`serve()`'s `launchHook` option no longer takes `timeoutMs`: the host always has 10 seconds to answer a firing, as with a hook set from `AGENTRUN_LAUNCH_HOOK_URL`. In 0.1.0-beta.54 a program that started the server itself could set another bound. A program that set it drops it.
