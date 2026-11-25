---
packages: @parcha/agentrun-serve
kind: ci
---
serve's test suite waits less: a test server's timeline long poll reads every 100 ms instead of every second, the end-of-run cost read's bound is a test option for native and SDK runs as it already was for adapter runs, and the slowest cases wait on events or a shifted clock instead of real timeouts and leases. No case was removed and no assertion was weakened.
