---
packages: @parcha/agentrun-dsl
kind: fix
---
Validation refuses parallel branches that write the same label. An unaliased agent, decide or extract node writes its result under its label, but the parallel disjointness check read only `as`, so two such branches with one label passed validation and then failed every run at the merge with `parallel_write_conflict`. They are now refused with `PARALLEL_WRITE_CONFLICT` before anything runs. `declaredWrites`, which hosts can call, now includes that label. A code node's patch keys are still known only when it runs, and the merge still refuses a collision there.
