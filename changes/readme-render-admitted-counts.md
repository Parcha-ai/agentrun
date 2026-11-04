---
packages: repo
kind: docs
---
The README's Render option gives the runs each instance admits now that a run is admitted by the memory its harness takes: a Starter's 512 MB runs 3 pi agents or 2 Codex runs at once, and a 2 GB instance 10 Codex runs. It says the image leaves Claude Code out for now (the Dockerfile removes the Claude Agent SDK and CLI), so Claude Code agents run with `npx @parcha/agentrun`. The old figures (650 MB a Claude Code run, 400 MB a Codex run) predate the chunked check of a harness binary.
