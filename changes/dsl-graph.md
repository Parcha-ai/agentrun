---
packages: @parcha/agentrun-dsl, @parcha/agentrun-pi
kind: feature
---
`@parcha/agentrun-dsl/graph`, an import-free subpath: `workflowGraph(workflow)` returns the nodes (JSON Pointer path, kind, label, `via` for a call) and edges (`next`, `branch`, `route`, `item`, `child`) of a workflow document from its JSON alone, and `nodeStatus(graph, source)` says for each node whether a run has it `done`, `working`, `failed` or `not-run`, from the recovery driver's frame and the map items' records. A map that ended on an item's failure (`pin.partial`) is failed, and a node inside a map's or loop's body is not done before the map or loop is.
The pi session's text view now takes its node list from `workflowGraph`, so the terminal view and a graph panel cannot disagree about which nodes a workflow has.
The subpath's fixtures (`packages/dsl/test/fixtures/graph`: a sequence, a parallel, a route, a nested map with a child workflow, and a map in each layout, each finished and cut, with the driver's frame and the map items' records) come from `generate.mjs`, so a panel's test reads what a real run kept.
One recording of the nested shape in the keyed layout, cut by a kill and resumed (`packages/dsl/test/fixtures/graph/nested.recording.jsonl`, the store's durable lines), comes from `examples/graph/run.ts` through the reference entry; a test reads it back through `nodeStatus` at every commit. The entry's `Job` takes an optional `layout` (`v4` keeps the map items as `agentrun.items` documents).
