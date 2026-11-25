---
packages: @parcha/agentrun-import
kind: feature
---
`parseHome` reads files on worker threads (`threads`, default the cores less one, at most 16, and what free memory holds; `1` reads on the calling thread as before), with the same totals at any count. `readAhead` caps finished reads waiting, and the CLI takes `--threads` and `--read-ahead`.
