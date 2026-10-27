---
packages: @parcha/agentrun-dsl
kind: feature
---
`submitParameters(schema)` is exported: the input schema of a node runner's `submit` tool, the node's output schema under `value` with its local `$ref`s moved with it. The Pi runner uses it, and so does any other runner, so a node's schema behaves the same on every harness.
