---
packages: @parcha/agentrun-dsl
kind: fix
---
A dry run no longer builds an unbounded value from a workflow's schemas. `synthesizeInstance` and `dryRunWorkflow` count every value and string character they synthesize against a budget, and stop past it: a schema that asked for a huge value (two nested arrays of `minItems: 10000`, 100M items) used to run the host out of memory, and now throws `SynthesisTooLarge` within the budget, the dry run ending `not_run` with "the schema is too large to synthesize". The default (`SYNTHESIS_BUDGET`) is one million values and 16 million characters across a dry run, far past what a real workflow's dry run builds; `DryRunOptions.budget` (and `synthesizeInstance`'s fourth argument) sets another.
- Upgrading: nothing to change.
