---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client
kind: feature
---
Keep newly connected Codex and Claude Code setups in sync by default, and move a supported complete setup to AgentRun from the existing agent page. Move preserves the agent's identity, history, source capture and unified usage, and checks destination tools, accounts, model, policy and project restoration before switching execution.

Managed runs retain project checkpoints for later runs. Source and managed changes produce reviewable conflicts;
uncertain saves require review before another run. Existing connections require an explicit export grant, native
credentials stay at the source, and unsupported capabilities remain named prerequisites. See
[source sync](../docs/source-sync.md) for compatibility and recovery behavior. Automatic notes and learned skills
remain retired; authored source skills retain their files and modes.

Unknown source storage-write outcomes retain receipts and block deletion until independently resolved; restarting
or acknowledging a run checkpoint does not clear a source write receipt.
