---
packages: @parcha/agentrun-harness-codex, @parcha/agentrun-harness-claude, @parcha/agentrun-serve
kind: fix
---
Checking the pinned Codex binary and Claude Agent CLI against their sha256 reads them a megabyte at a time, not whole. Each check read the whole file into memory: 294 MB for Codex and 230 MB for the CLI, in the server at its start and at each save and start of a run on those harnesses, and again in each run's own process. On a host of 1 GB or less the last of those buffers stayed, so the server sat at about 345 MB from its start, not 80 MB. A codex run now takes about 140 MB, down from 390 MB, and a claude-agent run about 215 MB, down from 470 to 670 MB. The digests and every pin error are unchanged.
