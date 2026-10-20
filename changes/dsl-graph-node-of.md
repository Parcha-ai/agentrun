---
packages: @parcha/agentrun-dsl
kind: feature
---
`@parcha/agentrun-dsl/graph` exports `graphNodeOf(graph, executionPath)`: the graph node an execution path ran at, `{ path, at }`, with `at` the map items and loop iterations it ran in, outermost first (`{ kind: "item" | "iteration", index }`). An execution path is the node's JSON Pointer with `items/<i>` before a map's `body` and `iterations/<i>` before a loop's; `graphNodeOf` reads it by walking the graph by node kind, so a route branch named `items` or `iterations` stays a branch, and a path the graph does not have, or one that is not an execution path, is `undefined`. The module still imports nothing.
