---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-computer
kind: breaking
---
`computer_script` is gone: a desktop or phone run scripts its computer through the host's `codemode`, whose script has the computer as `computer` (its types in codemode's description), and each of its calls is a nested call, held to the run's gate and recorded on the timeline. A shell command is held to the agent's `bash` setting, a started process to `bash_background`, a file written to `write`, and a file read to `read`. An agent definition or an MCP client that named `computer_script` uses `codemode` instead (Codex, whose code mode takes no binding, calls the computer's tools and the new script-only `computer_op` as nested calls). An earlier run's `computer_script` rows still read as they did.
