---
packages: @parcha/agentrun-pi
kind: fix
---
A limit given as `undefined` now keeps its default, as an omitted one does, in `createAgentRunExtension`'s `runtimeLimits` and in `WorkflowExtensionService`'s `limits`. Before, a field present with the value `undefined` (as an options object built from optional configuration has) was refused as an invalid limit. An explicit `null` still lifts a limit, and any other invalid value is still refused.
