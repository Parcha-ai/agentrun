---
packages: @parcha/agentrun-eve, @parcha/agentrun-client, @parcha/agentrun-serve, @parcha/agentrun-dsl
kind: feature
---
Connect an existing eve 1.0.0 agent through an additive extension, preserving its model, tools,
permissions and durable execution. AgentRun records the actual eve runtime, compiles workflows from
complete task evidence, and supplies owner corrections and served workflows to subsequent turns. Stable turn
keys and bounded event replay handle eve's buffered step writes without duplicate records on retry. Learning Off supplies no
learning to a new turn. The extension is held from publication while its integration is reviewed.

Optionally reuse checked workflows over the existing application's explicitly approved read-only
callbacks through a private local MCP bridge. Admission remains bound to the current turn and
pinned revision, with one workflow invocation per turn and Learning Off checked before dispatch.
Mutating tools and model/judgment callbacks are not supported in this initial eve workflow mode.
The cookbook includes a fresh-session workflow reuse and Learning Off comparison.
Workflow context names the original native callbacks found by inspecting each pinned workflow,
so the agent can compare it with its existing task and standing tool policy.
Keep host-configured delegation guidance separate from learned reference data. Matching workflows
are preferred only within the original policy; explicit direct-tool requirements take precedence.
SDK compilation describes when a workflow matches the task and what its input fields mean, without
adding a manual-invocation requirement. The existing agent can select it for an ordinary request;
execution still requires its explicit MCP tool call and the original permissions. This applies to
new drafts, revisions and compiler retries, not a rewrite of already-committed learning.

Show the actual harness mark beside connected agents and observed sessions, including eve,
Claude Code and Codex. Workflow agents keep a distinct workflow icon.

Keep the workflow schema discoverable by production dependency tracers when embedding the interpreter in an eve application.

Package the extension with its runtime asset requirements and include it in release archive verification.
An existing eve application can install the candidate archives and add one extension mount without
workspace links or changes to its model, tools or build options. Document corrections onboarding and
the additional explicit read-only bindings required for executable workflows.
Enabling learning on an Off eve agent preserves the server's current learning model. Without
workflow bindings, turns receive the owner's corrections; automatic workflow compilation requires
explicit bindings. Preserve an already-enabled learning configuration when another client saves it
before the switch's update.

Support configurable full-learning settings for Eve registration and workflow execution, and preserve
an already-enabled loop configuration when the console refreshes before saving. The fresh-agent
cookbook opts into a five-run compilation threshold without changing acceptance thresholds.

Scope bounded native evidence to the recorded turn boundary, so an invalid or oversized buffer
does not disable future turns. Skip unverifiable learning without inventing a completion, and
resolve workflow input schema references before advertising them in the native context.

Label tool credentials as API Keys in console settings and retain all repository and third-party
attributions in the package archives.
Browser archive verification recognizes both required vendor provenance manifests and continues
to reject unlisted files.
