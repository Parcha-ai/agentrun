---
packages: @parcha/agentrun-serve
kind: fix
---
A connected agent's workflow check now holds only after five give-backs in a row, never counts a cancelled turn, and starts the count again when a turn lands. A check held that way is never stopped for good: the agent's next compile revises the workflow and checks the revision afresh.
