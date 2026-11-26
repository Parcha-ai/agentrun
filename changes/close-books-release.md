---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A runner's graceful `close()` now resolves only after each live run's tool hosts have let go of what they hold, and their charges are booked under the claim the runner still holds. Before, the shutdown sealed the run's journal and aborted its ledger first, so a browser session's release charge was refused ("a tool host's beforeRelease failed: the loop stopped (shutdown)") and a priced computer's last stretch went unbooked. A shutdown's seal now lets the release hooks' commits through until they return; the claim's fence still refuses them once the claim is lost. On the run's cap, money already owed (a computer's time, a browser session's release) is booked after the run's stop, since nothing starts with it; every other step is still refused after a stop.
