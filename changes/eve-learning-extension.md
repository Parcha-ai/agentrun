---
packages: @parcha/agentrun-eve, @parcha/agentrun-client, @parcha/agentrun-serve, @parcha/agentrun-dsl
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

Keep the workflow schema discoverable by production dependency tracers when embedding the interpreter in an eve application.

Package the extension with its runtime asset requirements and include it in release archive verification.
An existing eve application can install the candidate archives and add one extension mount without
workspace links or changes to its model, tools or build options. Document notes/skills onboarding and
the additional explicit read-only bindings required for executable workflows.
Enabling learning on an Off eve agent in the console now selects notes and skills, so ordinary
connected tasks can learn without requiring a workflow catalog. Preserve an already-enabled
learning mode when another client saves it before the switch's update.

Support configurable full-learning settings for Eve registration and workflow execution, and preserve
an already-enabled loop configuration when the console refreshes before saving. The fresh-agent
cookbook opts into a five-run compilation interval without changing acceptance thresholds.
