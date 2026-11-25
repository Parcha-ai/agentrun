---
packages: @parcha/agentrun-dsl
kind: ci
---
The DecisionProvider conformance suite's mutation test runs every mutant in one process, and its scripted provider clears the timer of a request the suite aborted, so the test takes seconds where it took close to three minutes.
