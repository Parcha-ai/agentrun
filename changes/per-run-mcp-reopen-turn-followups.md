---
packages: @parcha/agentrun-serve
kind: fix
---
MCP: only the message that reopens a run skips the per_run credential check. Before, if that message was refused or left for later, the next message skipped the check too, and a message that handed the credential of a server the run was left without ran without that server's tools instead of waiting for a turn that had them. A run waiting in its claim on a person's answer also parks on its question at once when the answer is refused after a later message was left for the run's next turn. Before, it stayed in its claim, holding its browser and the person's time under the cap, until a hold lapsed.
