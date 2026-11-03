---
packages: @parcha/pi-durable-agent, @parcha/agentrun-serve
kind: fix
---
A claude-agent or codex run that a stop or a crash cut off mid-tool, and that the next process resumed, completes once it answers. The cut call's "interrupted" row used to be made at the end of the timeline, after the answer, when the next process's turn ended, and the server reads a run's last row to know it answered: the run stayed Working until another restart. The row now sits right after its call, in the live timeline and in the stored one.
