---
packages: repo
kind: breaking
---
`@parcha/agentrun-dsl/recovery`: a pause lets an effect in flight complete. Breaking for a host that relied on a pause cutting an effect. `driver.stop({ action: "pause" })` refuses new work at once and is taken when no effect is in flight: an effect already admitted dispatches, completes and commits its receipt first, so a paused run resumes without a reconciliation. Before, a pause aborted the effect through the driver's signal and left it unknown. New work (a node's resume, an effect, a wait, a step's attempt) waits at the new `driver.seam()` until the pause is taken and is then refused with `FROZEN_PAUSED`; finished work still commits. A cancel is unchanged: it is immediate, and the effect it cuts stays unknown. The recovery models do not move: neither has a stop, a pause adds no state between an admission and its completion, and the state a cancel leaves is the one a crash leaves.
