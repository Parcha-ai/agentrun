---
packages: @parcha/agentrun-dsl
kind: fix
---
A dry run no longer builds an unbounded value from a workflow's schemas. `synthesizeInstance` and `dryRunWorkflow` count every value and string character they synthesize against a budget, and stop past it: a schema that asked for a huge value (two nested arrays of `minItems: 10000`, 100M items) used to run the host out of memory, and now throws `SynthesisTooLarge` within the budget, the dry run ending `not_run` with "the schema is too large to synthesize". The default (`SYNTHESIS_BUDGET`) is one million values and 16 million characters across a dry run, far past what a real workflow's dry run builds; `DryRunOptions.budget` (and `synthesizeInstance`'s fourth argument) sets another.
An object's property names are charged their characters (a key is built into every value under it), a schema synthesis cannot read is its one-character `"x"`, a const or an enum literal is charged its serialized size, a budget field given as `undefined` keeps its default, and a `$ref`, `anyOf` or `oneOf` is charged as the one value it leads to.

A dry run is bounded by the work it does, too, not only by its synthetic steps: every node visit (a loop's body each iteration, a map's body for each item) counts against `DryRunOptions.maxVisits` (ten times `maxSteps` by default), and the run stops past `DryRunOptions.deadlineMs` (60 s by default), read from the clock at each visit and step. A loop whose body asks nothing (a map over an empty list) and whose `until` never holds used to spin the host; it now ends `not_run`. `WorkflowDeps.onVisit` is the hook: called at each node's visit, before it runs.
- Upgrading: nothing to change.
