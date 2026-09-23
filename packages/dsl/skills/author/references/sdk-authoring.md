# The SDK authoring path

Use this path when the host calls `authorWorkflow` from `@parcha/agentrun-dsl` rather than exposing the `agentrun` tool. The host supplies its own `runNode` adapter; the author asks it for one session with no tools and a `submit` tool. Deliver each candidate as the submit tool's value. Read validation and acceptance feedback, then repair within that session. The host retains each version and rejection. Acceptance does not activate or execute a replacement.

The session's system text is the [language reference](language.md) followed by the host's addendum, when the host supplies one. The addendum names the host's initial state, output types, node kinds and rules. Candidates using a node kind or artifact type outside a declared addendum are refused before validation.

With `rubricSections`, every generated LLM node must reference every supplied section, including child workflows. This conservative author policy rejects Jev nodes, semantic `ask` predicates, and `verify` clauses until the host has a separately reviewed question contract. Execution must receive the same authoritative SOP text. A schema field named `node`, `verify`, or `predicate` is ordinary data, not a judgment clause.

Host-owned acceptance callbacks and fixtures remain outside generated workflows. Do not edit them to obtain a pass. Structural acceptance alone does not establish behavior. Keep request text, rubric text, candidates, and reviews in storage appropriate for their contents.
