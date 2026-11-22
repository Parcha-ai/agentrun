---
packages: @parcha/agentrun-serve, @parcha/agentrun, @parcha/agentrun-client, @parcha/agentrun-harness-codex
kind: feature
---
Keep newly connected Codex and Claude Code setups in sync by default, and move a supported complete setup to AgentRun from the existing agent page. Move preserves the agent's identity, history, source capture and unified usage, and checks destination tools, accounts, model, policy and project restoration before switching execution.

Managed runs retain project checkpoints for later runs. Source and managed changes produce reviewable conflicts;
uncertain saves require review before another run. Existing connections require an explicit export grant, native
credentials stay at the source, and unsupported capabilities remain named prerequisites. See
[source sync](../docs/source-sync.md) for compatibility and recovery behavior. Automatic notes and learned skills
remain retired; authored source skills retain their files and modes.

Moved agents can learn checked workflows on the server using their existing learning settings. Replay and eligible
shadow-audit runs receive isolated copies of the reserved project; their results remain learning evidence, while
their settled file changes are explicitly discarded rather than published to the saved project. Uncertain writes
retain recovery receipts, and the existing restrictions on auditing write-capable agents still apply.

Supported HTTP MCP connections retain source tool selections and denials, with explicit destination account binding.
Resource lists, templates and reads use the same pinned grants, credentials and permission gate; resource-only servers
are supported on managed AgentRun; native Codex 0.171.0 has a resource-only discovery limitation. Incomplete resource listings fail visibly, and resource bodies that echo connection credentials are
scrubbed or withheld before filing. Three upstream tool names are now reserved for these generated resource operations:
`agentrun_list_resources`, `agentrun_list_resource_templates` and `agentrun_read_resource`. A conflicting upstream tool
must be renamed before its server can connect. Stdio connections and unsupported native capabilities remain prerequisites.

Unknown source storage-write outcomes retain receipts and block deletion until independently resolved; restarting
or acknowledging a run checkpoint does not clear a source write receipt.

The Codex adapter preserves native rollout ordinals when recording an approved tool's result before resuming. This
fixes pinned Codex 0.164.0 rejecting the resumed thread after approval. Existing mixed or invalid ordinal histories
remain retained and fail before another tool dispatch; they are not silently rewritten or retried. Older wholly
unnumbered journals retain their format. This serialization fix leaves recovery admission, intent and result ordering
unchanged, so the recovery models do not change.
