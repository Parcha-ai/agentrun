---
packages: @parcha/agentrun-serve
kind: fix
---
Only a schedule trigger's run is handed its trigger's last completed `result.output`. A Composio, GitHub or webhook trigger's run no longer is, as an email's or a feed's already wasn't: each of their firings is a different event, so one sender's answer was reaching the next sender's run. A source opts in with its adapter's `previousResult: true`.
