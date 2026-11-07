---
packages: @parcha/agentrun-serve
kind: ci
---
`learned-route-real.test.mjs`'s restart cases close their second server before the test ends, as its cut case does: the first server's after-hook removed the data directory the two share while the second, and its run's process, still wrote there (`ENOTEMPTY`), and the hook's failure skipped the second's close, so the file then hung until its timeout. Each restart case now also checks that no process of its runs outlives it.
