---
packages: @parcha/agentrun-serve
kind: fix
---
The console's API playground no longer says an empty `max_cost_usd` means no cap. When the agent has a default cap,
the box shows it (for example `$0.25`) and says an empty box uses it, as the agent page's run bar already did.
With a revision picked, the box shows that revision's default cap, since a run takes the cap of the revision it runs.
