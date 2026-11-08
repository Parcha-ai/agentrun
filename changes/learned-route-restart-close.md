---
packages: @parcha/agentrun-serve
kind: ci
---
A serve test's server started on another server's data (a restart's, `serve(t, { data: first.data })`) is closed before the first server's after-hook removes that directory. node:test runs after-hooks in the order they were added, so the first server's ran first and removed the directory while the second, and its run's process, could still write there (`ENOTEMPTY`); the hook's failure skipped the second's close, so the file then hung until its timeout. `support.mjs` `serve()` now closes every server started on a directory it made before it removes it, and `trigger-engine.test.mjs`'s `engine()` does the same for its engines. `learned-route-real.test.mjs`'s restart cases also close their second server themselves and check that no process of their runs outlives them, as its cut case does.
