---
packages: @parcha/agentrun-codex
kind: feature
---
The Codex adapter says what Codex 0.164.0 does to a tool's schema, so no difference is silent. Codex sanitizes the schema its model is given: it strips bounds, patterns, formats, titles, defaults and a few annotations, and it drops or retypes a few shapes (a tuple `items`, `prefixItems`, `patternProperties`, `if`/`then`/`else`, `not`, a non-scalar or untyped non-string `enum`/`const`, `contains`, `dependentRequired`, `propertyNames`, a boolean `items`, constraints inside `allOf`). Checking a session now refuses each of those shapes by tool, JSON pointer and keyword, before anything is paid. For the stripped keywords, the tool's description lists them in plain words under one fixed heading, sorted by pointer, so the model still reads them; the host and the DSL keep checking against the original schema. The measurement is recorded for the public schema corpus and replayed offline.
