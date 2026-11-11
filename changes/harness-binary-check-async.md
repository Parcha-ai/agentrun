---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel, @parcha/agentrun-harness-claude, @parcha/agentrun-harness-codex
kind: fix
---
Checking a harness's pinned binary no longer stalls the server. claude-agent's CLI (about 240 MiB), Codex and OpenCode were hashed and asked their `--version` synchronously whenever the server built their adapter: at its start's harness probe, when an agent on that harness was saved, and when a run started. While that ran, every request waited and an open store transaction stayed open, so a save could answer `409 home_busy` or `500` on a loaded host. The check now reads the binary a chunk at a time and awaits `--version` with the event loop free: `sha256OfFileAsync` and `checkedOnceAsync` in `@parcha/agentrun-kernel/host`, `verifyClaudeAgentCliAsync`, `verifyCodexBinaryAsync` and `verifyCodexAsync`. A check that passed is kept for the process as before, so the adapters' own synchronous check answers from it at once.
