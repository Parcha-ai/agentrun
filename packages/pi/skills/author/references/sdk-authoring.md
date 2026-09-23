# Demo commands and standalone SDK

## Demonstrations

`/agentrun demo` runs the interpreter with scripted responses over fictional sources. `/agentrun demo empty` exercises insufficient evidence. Neither makes model calls. `/agentrun demo live` uses real Pi agent calls and Jev system one decisions over the same fictional sources; TypeSafe access is required. It is still not web research.


## SDK authoring only

Use this path when the host invokes `authorWorkflow` rather than the native `agentrun` tool. The SDK supplies a `submit` tool; deliver `{"value": workflow}` through it. Read validation and acceptance feedback, then repair within that session. The host retains each version and rejection. Acceptance does not activate or execute a replacement.

With `rubricSections`, every generated LLM node must reference every supplied section, including child workflows. This conservative author policy rejects Jev nodes, semantic `ask` predicates, and `verify` clauses until the host has a separately reviewed question contract. Execution must receive the same authoritative SOP text. A schema field named `node`, `verify`, or `predicate` is ordinary data, not a judgment clause.

Host-owned acceptance callbacks and fixtures remain outside generated workflows. Do not edit them to obtain a pass. Structural acceptance alone does not establish behavior. Keep request text, rubric text, candidates, and reviews in storage appropriate for their contents.

SDK configuration and file retention are not features the native author must reimplement. The installed Pi package README documents `authorWorkflow`, `createPiHostRunner`, and the separate CLI.
