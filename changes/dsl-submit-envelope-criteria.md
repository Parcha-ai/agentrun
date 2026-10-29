---
packages: @parcha/agentrun-dsl
kind: fix
---
**`submitParameters` leaves `criteria` out of the submit tool's schema**
- `criteria` is System One's question keyword: DSL vocabulary, not JSON Schema. A node's output schema could carry it into the submit tool the model sees, on every harness, and a harness that refuses unknown keywords refused the tool (the issue-triage example's `Judgment` schema as an agent output, for one). The envelope now drops it from every schema object it walks.
- A property, `$defs` or `definitions` entry NAMED `criteria` keeps its name and its schema. Annotations (`title`, `description`, `examples`) and any other keyword stay as written.
- Validation does not change: a runner and the interpreter check a submission against the node's schema as written, and `criteria` has no validation meaning, so no verdict differs.
