---
packages: @parcha/agentrun-serve
kind: fix
---
The end-of-run learning prompt says when a job is a workflow draft rather than a skill (one that runs end to end as model and tool-call steps from a defined input to a defined output, or that the person asks to keep as a workflow), and its example draft is whole and valid: schemas declared once, `input` and `output` naming them by `schemaId`, a chain of a `web_fetch` call (when the agent has it) and a model node. Before, agents asked for a workflow kept a skill, and the drafts they wrote were refused (an inline schema in `input`, or none named), as the only example elided its parts. A test validates the prompt's example with the workflow DSL and the learning checker. The prompt also names the node kinds a learned workflow may use: model and tool-call nodes only.
