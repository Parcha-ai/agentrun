---
packages: @parcha/agentrun-serve
kind: breaking
---
A script's `computer.files.write` (`computer_op` with `files.write`) needs `write` among the agent's tools: an agent not given `write`, or naming no tools, is refused it in words whatever `write`'s setting says. Before, `write`'s default (allow) let it through, so on a desktop that mounts the run's folder such an agent could write into the run's files.
