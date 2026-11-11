---
packages: @parcha/agentrun-serve
kind: fix
---
Fixes a learning run whose cap you raised mid-run being told it had no budget left to look back. A run paused at a $0.001 cap and raised to $1 completed, then its learning read "Skipped: no budget left in this run to look back" with $0.994 of the $1 left: the end-of-run check compared the run's spend with the cap it started with. It now reads the cap the run is held to after a raise, the same one each of its requests is admitted under and its view shows, on pi and on claude-agent, codex and opencode.
- Upgrading: nothing to change.
