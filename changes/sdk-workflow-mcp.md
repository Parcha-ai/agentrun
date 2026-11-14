---
packages: @parcha/agentrun-client, @parcha/agentrun-serve, repo
kind: feature
---
Let checked backend SDK workflows reuse existing application tool callbacks through an explicit local MCP bridge. The host supplies its workflow engine, tools and live permission policy; run-scoped capabilities, schema checks and cancellation bound execution. Capability-aware reflection and grading propose only runnable workflows, and the cookbook compares fresh-input workflow reuse with a learning-Off control.
Keep each bridge callback and result under its validated workflow invocation in the run timeline, so successful workflow-only work retains its workflow cost path while failed callbacks and extra agent work remain handed back.
An explicit `nativeMcpServerName` also correlates duplicate native MCP envelopes against one-use bridge completion receipts with the same session capability, arguments, status and result. Unconfigured or unmatched native calls remain ordinary tool evidence.
SDK workflow checks and selection refuse automatic tool retries the bridge cannot execute, and evidence cannot close a workflow while one of its nested callbacks is unfinished.
The SDK callback catalog’s advertised schema uses the runtime MCP tool-name grammar: leading dashes are valid, dots and tools longer than 64 characters are refused.
Workflow admission and SDK delivery reject repeated scoped step labels while preserving declared backend callbacks and the bridge's retry limits.
SDK proposal checks and approved workflow delivery honor the bridge’s 128-node static limit, including nested chains and composed workflows, without restricting managed workflows.
SDK jobs use the ordinary note/run compilation thresholds and a separate compiler turn. Its host contract, examples and checks use only explicitly registered backend callbacks, without hosted workflow-first, model or step-guard authority. Each independent SDK retry carries the bounded, redacted original compiler context and its previous failed answer; durable attempt IDs preserve paid-once recovery and the task-versus-learning cost breakdown.
