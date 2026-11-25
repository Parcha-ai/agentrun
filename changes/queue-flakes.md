---
packages: @parcha/agentrun-serve, repo
kind: fix
---
`agentrun-serve eval-template` no longer hangs at exit after it has printed its result (about 1 run in 160). The command now lets Node exit normally instead of calling `process.exit`, which could stop the V8 worker threads while a background compile was waiting for a garbage collection.
A pull request's CI now always runs the tests that scan the whole repository (`TREE_WIDE` in `scripts/test-affected.mjs`: entry-points, typebox-out, doc-checkpoint, check-doc-anchors). Before, a pull request that broke one of their policies passed its own checks and failed first in the merge queue, along with every group queued behind it.
Four flaky serve tests are fixed. Capture-git's fixture repository no longer runs git auto-maintenance. `raw()`'s SQLite statements run on a worker, so a write never blocks the commit it waits for. Runner-command-wake and graph-redact now count work instead of timing a window.
