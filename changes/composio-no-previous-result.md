---
packages: @parcha/agentrun-serve
kind: fix
---
Only a schedule trigger's run is handed its trigger's last completed result after its message. A run a Composio, GitHub or webhook trigger starts is handed none any more, as an email's or a feed's already was. Each of their firings is a different event (a new issue, a pull request, a Gmail or Linear message, a form submission), often from a different person, so one run's structured answer was reaching the next: bob's run could read, and a draft reply could quote, what the agent answered about alice's. A job that should leave out what it reported last time runs on a schedule, which still hands its last completed `result.output`.
