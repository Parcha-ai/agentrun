---
packages: @parcha/agentrun-serve
kind: fix
---
A run whose runner was lost, and whose next claim then ended before its own computer started, no longer leaves the lost runner's computer running until its deadline. Before, the earlier claim's sandbox (and a Docker computer's egress volume) ran on for up to a day on Docker, or the vendor's lifetime elsewhere, whenever the next claim's image failed, its computer was refused on that runner, a person stopped or cancelled the run, the claim was refused before its computer, or that claim was lost too. Now, when a run is over, the runner deletes every computer any of its claims made, by the run's label. The computer janitor also ends a finished run's computers on its next sweep, without waiting for their deadline. A persistent computer and a paired computer are never deleted.
