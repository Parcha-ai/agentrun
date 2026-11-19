---
packages: @parcha/agentrun-serve
kind: fix
---
A run a Composio trigger starts is no longer handed the trigger's last completed result after its message. Each delivery is a different event (a new GitHub issue, a Gmail message, a Linear issue, often from a different person), so one run's structured answer was reaching the next: bob's run could read, and a draft reply could quote, what the agent answered about alice's. Composio now hands none, as email and feed triggers already did. A schedule's run is still handed its last completed `result.output`, as before.
