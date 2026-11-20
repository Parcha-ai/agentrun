---
packages: @parcha/agentrun-client, @parcha/agentrun-serve, @parcha/agentrun-eve
kind: fix
---
Keep compiled workflow drafts out of connected agents' reusable workflow lists until a shadow check compares them with an independent native answer. Claude Agent SDK, Codex SDK and Eve use the same reserved candidate, caller-side execution and server promotion decision; native and remote runner tools also withhold unchecked drafts.

The first check uses one fresh native turn and reports that sample count. It compares the full answer exactly, or the owner's configured agreement fields. A mismatch, missing evidence, expired check, ambiguous input or failed execution never promotes a draft. Original native results remain unchanged. Shadow writes use only that turn's matching recorded results; an unrecorded write stops the check. Reads also use recorded results by default; `shadowReadFallback` explicitly opts into missing read-only observations under the host's existing policy, never retries failed calls. Complex input mappings can supply `resolveCheckInput`; the default does not guess fields from prose.

Write-bearing checks require complete serial native tool lifecycles and a serial candidate preserving every original call once and in order, including reads. Unknown tools, overlapping calls, buffered Codex write traces and parallel write candidates remain unpromoted. Read-only turns retain recorded-read reuse and reordering. Raw callback results preserve their values and types; only SDK-confirmed MCP envelopes are decoded, and ambiguous or error responses stay held. Asynchronous schema validators are rejected before invocation.

Eve now uses the shared durable delivery client and an in-process workflow binding. Old pending delivery failures remain recorded without blocking new native turns. Context says compiled workflows and leaves selection to the agent; it no longer claims owner approval or instructs the model to prefer a workflow. The unused Eve mount threshold options are removed; existing server agent learning settings remain authoritative.

Agent Learning and Learning Dojo now show when the selected learning model lacks server access, name the model, and link to API Keys. Readiness checks the actual learning route rather than accepting any saved key or an unrelated default model. Native connections keep their own sign-in. SDK background compilation requires server-owned model access; a per-request gateway key alone is insufficient. The read-only readiness fields make no paid request and do not verify quota.
