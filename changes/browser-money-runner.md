---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/pi-browser
kind: fix
---
A browser run's money on the runner is counted once and shown. `/v2/usage` shows a runner run's browser time again (its `browser_time` meter read per-run files the runner never writes). A run parked at its cap by a browser call shows the cap's words on its budget card, where its reason was empty. Each browser charge is booked once on the run's ledger, under its real call when it has one, named by its session and time so a reopen never books it twice; a charge owed at the provider (a session's release, a person's carried time) is booked past the cap, as main kept it. The browser's holds (a call's, a session's reserve, a person's time) are money reserved, never spent: a lost claim gives them back, never leaves them counted as spent.
