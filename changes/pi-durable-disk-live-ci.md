---
packages: @parcha/pi-durable-disk
kind: ci
---
A local live runner, `test/live/ci.ts all`, for the ship skill to run before a change to this package ships: `npm run build && node packages/pi-durable-disk/test/live/ci.ts all` under a credential wrapper that exports `ARCHIL_API_KEY`, `PDA_LIVE_DISK` and `PDA_LIVE_REGION` for a scratch organisation and a scratch disk. It refuses to start without the key (the suites would otherwise skip and pass), runs the host suites and then the Docker suites, each under a deadline, always sweeps the run directories and token users a cut suite left, prints the suites' timings, and ends on `ok: live disk check passed (...)` or `not ok: <step>: <reason>`. `all --slow` adds `supervise-slow`, the three supervise tests that wait out fixed windows (about 17 minutes), now a file of their own. The live suites now give their run directories the running user's uid rather than 1000.
