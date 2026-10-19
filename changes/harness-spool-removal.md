---
packages: @parcha/agentrun-harness
kind: fix
---
`finishRecording` no longer fails with `ENOTEMPTY` when a writer that outlived its kill (a place that refused it) adds a file to the spool while it is removed: the removal is retried for up to two seconds, and any other error, or one that lasts, is thrown as before.
