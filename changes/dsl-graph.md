---
packages: @parcha/agentrun-dsl, @parcha/agentrun-pi
kind: feature
---
`@parcha/agentrun-dsl/graph`, an import-free subpath: `workflowGraph(workflow)` returns the nodes (JSON Pointer path, kind, label, `via` for a call) and edges (`next`, `branch`, `route`, `item`, `child`) of a workflow document from its JSON alone, and `nodeStatus(graph, source)` says for each node whether a run has it `done`, `working`, `failed` or `not-run`, from the recovery driver's frame and the map items' records.
The pi session's text view now takes its node list from `workflowGraph`, so the terminal view and a graph panel cannot disagree about which nodes a workflow has.
The subpath's fixtures (`packages/dsl/test/fixtures/graph`: a sequence, a parallel, a route, a nested map with a child workflow, and a map in each layout, each finished and cut, with the driver's frame and the map items' records) come from `generate.mjs`, so a panel's test reads what a real run kept.
