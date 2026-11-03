---
packages: @parcha/agentrun-serve
kind: feature
---
`agentrun-serve import` counts what it leaves out by why, on the dry run and the import alike ("left out: 84 sessions from folders that no longer exist (--include-deleted imports them too)", "left out: 2 sessions still being written: they come in next time"), in place of one `skipped <path>: <why>` line per file, which `--verbose` still prints. `--include-deleted` imports the sessions of project folders that no longer exist, such as a deleted git worktree's, each folder its own agent with no instructions or skills to read; `--all` keeps those, temporary folders' and sessions with no message of the person's, as before. Each left-out entry of an import's report carries its `kind`, and `leftOutOf` groups them.
