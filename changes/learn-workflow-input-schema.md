---
packages: @parcha/agentrun-serve
kind: fix
---
The `learned_workflow` tool shows each workflow's input as its schema says it, on a line under the workflow: its fields, their types, which are required (`*`) and a short description of each, so a call gives the input the workflow takes the first time. The line counts in the tool's description budget. A learned workflow draft whose output names no `path` is refused when it is kept and before a call runs any node: a learned workflow answers the value at `output.path`.
