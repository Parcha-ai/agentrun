---
packages: @parcha/agentrun-pi
kind: feature
---
When Pi starts with an `--tools` allowlist that leaves out `agentrun`, the session now shows a warning with the `pi --tools` line that enables the AgentRun tool. Before, Pi disabled the tool without a word. A workflow whose agent node needs a tool that is not active is now refused with the names of those tools, `Not registered: grep, find.`, instead of a refusal that names no tool. The README and the guide give Pi's stock default tools (`read`, `bash`, `edit`, `write`), the working `--tools read,grep,find,ls,agentrun` line, and `--approve` for `pi install ... -l` in a project that is not trusted yet.
