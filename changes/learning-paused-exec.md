---
packages: @parcha/agentrun-serve
kind: fix
---
A learning folder whose disk can't run its script (Archil with serverless exec off), or on which the script times out, now pauses learning: the run's learning is dropped `paused` and GET /v2/agents/{agent_id}/learning/loop says "learning paused: the disk can't run the folder script" (or "the folder script timed out on the disk"), where before each run counted a failed compile and the second stopped the agent's learning. No compile attempt is spent and nothing stops; once exec works the next run carries on.
