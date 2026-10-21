---
packages: @parcha/agentrun-pi
kind: fix
---
`createWorkflowTool` from `@parcha/agentrun-pi/durable` now checks its host's `tools` as the coding-agent extension checks `hostTools`, and throws when it is created with a list that fails: more than 100 tools, a name that is blank, longer than 200 characters, repeated, or reserved (the workflow tool's own name, `agentrun` by default, and the node runner's `submit`), or `parameters` that are not an object schema. Before, such a list was taken as given. Both hosts use one check.
