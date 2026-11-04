---
packages: @parcha/agentrun-dsl
kind: fix
---
A decision's deadline now counts the time its images take to load. `judgeFromProvider` and `judgeFromProviders` load a node's images within the provider's `deadlineMs` (or the node's shorter `timeoutMs`), and the provider gets what is left of it. Before, the clock started only once the images had loaded, so a `loadImage` that never returned held the decision forever. A load the deadline cuts fails `timeout`, and a load the run's cancel cuts fails `aborted`. So does a load that finishes past the deadline before its timer fires, for example while a loader's synchronous work holds the thread: the provider is not called with an expired budget. Nothing was sent in either case, so neither is `outcome_unknown`, and in a collecting map a `timeout` fails only its item. A `loadImage` that ignores its signal is cut too.
