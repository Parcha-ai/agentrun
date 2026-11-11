---
packages: @parcha/agentrun-serve
kind: fix
---
A runner no longer takes more runs than its host's memory holds. The run count (`--max-runs`, by default as many pi runs as fit) let a 2 GB host take 15 claude-agent or codex runs at once, about 3.2 GB of claude-agent runs as measured, and the out-of-memory kill then took every run on the box. Now a runner claims a waiting run only while the runs it holds and that run's harness size (pi 128 MB, codex 192, claude-agent 288, opencode 704) fit the host's memory (its container's limit when it has one) less the server's 128 MB; a run that does not fit yet waits queued, oldest first, until one ends. A run larger than all of it still runs, alone.
