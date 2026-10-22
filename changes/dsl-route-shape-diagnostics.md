---
packages: @parcha/agentrun-dsl
kind: fix
---
`inspectWorkflow` and the shape diagnostics name what a judged route lacks. The workflow schema has two route variants, a judged route (`instructions`, `state`) and a route by value (`valuePath`), and the diagnostics kept only the last schema per node kind. So a judged route missing its `state` was told it must have a `valuePath`. Every variant of a kind is now kept, and a node is diagnosed against the variant that accepts it, or else the one it is closest to. What the full validator accepts is unchanged.
