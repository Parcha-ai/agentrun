---
packages: @parcha/agentrun-serve
kind: fix
---
On a platform Codex or Claude Code ships no build for (no Codex target for it, as on Windows, where AgentRun pins no Codex binary, or no Claude CLI package for it in the lock AgentRun ships, as on 32-bit or FreeBSD hosts), the harness is unavailable from the start: `GET /v2/capabilities` lists it with the reason `no Codex build for this platform (<platform>)` or `no Claude Code build for this platform (<platform>)`, never `installs: "on_first_use"`, and a run on it is refused at once (`409 agent_not_runnable`, the same words). Nothing is installed for it: no npm, no temp directory, no registry request, however often a run starts or an agent on it is saved. A run an earlier server left waiting on that install, recovered on such a platform, ends failed with the same words instead of being launched again and again. Before, every start ran `npm ci` again and then failed.
