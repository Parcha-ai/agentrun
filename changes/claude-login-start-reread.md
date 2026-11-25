---
packages: @parcha/agentrun-serve
kind: fix
---
Where each run is a user of its own, the runner now reads Claude Code's login setting again when a run's process starts and asks for the login, and hands the login on only if that read names the same folder as the run's claim read. A run claimed on the login whose login was turned off, or moved to another folder, between its claim and its start now fails, refused in fixed words that name no folder ("turned off or moved to another folder since this run's claim"), instead of starting on the login its claim read. Start the run again to run it on the login as it is now, or give it a `model_key`. A run claimed while the login was off still never goes on a login turned on after its claim.
