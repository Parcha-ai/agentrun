---
packages: @parcha/agentrun-dsl
kind: fix
---
In a map with `onItemFailure: "collect"`, a judge that fails inside a `parallel` fails its item again, not the run. The parallel cancels the sibling judge still in flight, and Jev and OpenRouter report that cancel as `DecisionProviderError("aborted")`, not as an `AbortError`. The parallel reported the sibling's `aborted` over the item's own failure, so the map stopped. It now reports the first failure, and the map writes that item's `failedAs` row and finishes the others. A run that is cancelled still stops the map.
