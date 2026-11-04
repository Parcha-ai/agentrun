---
packages: @parcha/agentrun-dsl
kind: ci
---
agentrun-dsl drops eight tests that repeat a shared Lean conformance case, now that the `lean` check is required to merge: each case holds the Lean model and the TypeScript interpreter to the same verdict, state, error and events. From `lean-findings.test.mjs`: F1a (`requires-after-code`), F1b (`requires-empty-submission`), F2a (`parallel-code-collision`), F2b (`parallel-label-collision`), F3 (`code-writes-dollar-key`, `code-writes-host`), F7a (`parallel-host-scalar-then-array`, `parallel-host-array-then-scalar`) and F9 (`predicate-array-index`); F5 keeps only its typed-output half, since `child-undefined-output` holds the permissive one. From `predicate-not-field-type.test.mjs`: the single "abc" escalation (`escalate-not-field-type-fires`). Tests that check an error's wording, its position, or behaviour no case covers stay.
