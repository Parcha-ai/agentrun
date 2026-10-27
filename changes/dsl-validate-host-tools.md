---
packages: @parcha/agentrun-dsl
kind: feature
---
`validateWorkflow(workflow, { tools })`: an opt-in list of the host's tool names. Given, a node that names a tool outside it is refused at validation with `NODE_FIELD_INVALID`, at that node's path, naming the tool: an `agent`, `decide`, `extract`, `report` or `artifact` node's `tools`, a `call` node's `tool` with `via: "tool"`, and the same inside a child workflow. Absent, validation is unchanged, and an unknown tool is still refused when its node runs. The options' type is exported as `ValidateWorkflowOptions`.
