---
packages: @parcha/agentrun-serve
kind: breaking
---
A tool the owner ticks when applying a template is granted, not allowed: apply writes no permission for it, and each call follows this server's tool settings, as for any granted tool. Breaking: under approvals `ask`, a ticked write now asks the owner before it runs, unless the owner allowed that tool in this server's tool settings, where before it ran unasked; a ticked read runs unasked only where the owner turned on Allow reads for its server.
- Before, apply set every ticked tool to allow in the agent's own tool settings, so under `ask` a ticked write ran without asking, and the allow outranked the server's Allow reads rule.
- Approvals `never` still runs every granted tool without asking, as before. A deny the owner set on the server still holds, and a template's pins are written as before (a pin whose parameter is not given still sets the tool to deny).
- The console's apply screen says that a ticked tool is granted, that a write asks unless you allowed it in Settings or choose Never ask, and that a read follows Allow reads. The Never choice now says it runs without asking, even for writes, and that it is the one to pick when a trigger starts the agent while you're away.
- No migration: an agent applied from a template before this release keeps the allows apply wrote. To have its writes ask, remove the `permission: allow` from those tools in its tool settings.
