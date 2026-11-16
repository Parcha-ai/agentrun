---
packages: @parcha/agentrun-eve, @parcha/agentrun-client, @parcha/agentrun-serve
kind: feature
---
Connect an existing eve 1.0.0 agent through an additive extension, preserving its model, tools,
permissions and durable execution. AgentRun records the actual eve runtime, checks learning from
complete task evidence, and supplies accepted notes and skills to subsequent turns. Stable turn
keys and bounded event replay handle eve's buffered step writes without duplicate records on retry. Learning Off supplies no
learning to a new turn. The extension is held from publication while its integration is reviewed.

Optionally reuse checked workflows over the existing application's explicitly approved read-only
callbacks through a private local MCP bridge. Admission remains bound to the current turn and
accepted revision, with one workflow invocation per turn and Learning Off checked before dispatch.
Mutating tools and model/judgment callbacks are not supported in this initial eve workflow mode.
The cookbook includes a fresh-session workflow reuse and Learning Off comparison.

Show the actual harness mark beside connected agents and observed sessions, including eve,
Claude Code and Codex. Workflow agents keep a distinct workflow icon.
