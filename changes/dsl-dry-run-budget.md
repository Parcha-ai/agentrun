---
packages: @parcha/agentrun-dsl
kind: feature
---
`dryRunWorkflow` is bounded and can be stopped. It stops after `maxSteps` synthetic steps (an agent's or a judge's answer, an effect, a code node the host's `runCode` runs; 10,000 by default) or when its `signal` ends, and answers `ok: true` with `skipped` giving the reason. It also yields to the event loop every 64 steps, so a host takes a stop meanwhile. Before, a loop whose synthetic answers never met its `until` ran to its `maxIters` (which has no ceiling) and held the event loop for the whole time: a `maxIters` of 200,000 took 5 to 21 seconds, during which no timer ran.
