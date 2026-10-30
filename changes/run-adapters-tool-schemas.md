---
packages: @parcha/agentrun-kernel, @parcha/agentrun-harness-claude
kind: feature
---
`toolSchemaProblems(tool, schema)` lists what a harness adapter refuses in a host tool's input schema before a session starts, the same on every harness, each as `<tool>: <JSON pointer>: <why>`: a root that is not `{ "type": "object" }`, a schema that is not JSON or not valid JSON Schema 2020-12 (a `$schema` must name 2020-12, 2019-09, draft-07, -06 or -04), and a remote `$ref` (a local one into `$defs` is followed). An adapter's `check()` calls it first and then adds its own harness's measured refusals.
- The Claude Agent adapter's `check()` uses it, and also refuses a root with `anyOf`, `allOf` or `oneOf`, which the pinned CLI drops without a word, the tool missing from the session. Put the alternatives under a property. `open` refuses a session whose tools have any of these, naming each.
