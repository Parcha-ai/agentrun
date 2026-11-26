---
packages: @parcha/agentrun-serve
kind: fix
---
MCP: a message that reopens a run is now that run's next turn even when a later message hands the credential of a per_run server the run was left without. Before, both messages waited for a turn that had the server's tools. A run that had never started its agent, such as one its learned workflow answered alone or one stopped before its first input was sent, then kept reading as working with nothing running until someone stopped it. The later message still waits, and runs as the turn after, with the server's tools.
