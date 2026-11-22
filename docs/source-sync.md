# Sync a connected agent and move it to AgentRun

New source connections keep setup sync on by default. Sync copies the selected project's instructions, authored
skills and their assets, supported settings, tool requirements, project files and bounded Git history. It does not
copy native sign-in credentials or import past conversations. The connection command describes the scope before
export; `--no-sync` connects without exporting setup.

Git transfer covers the checked-out commit and its ancestry, its branch name and the working files. Other branch
and tag references, remotes and Git configuration are not migrated.

The source and server must use matching development builds. This feature does not change the published
observation-only connector.

## Connect once

On the same machine as a loopback AgentRun server, `agentrun-serve native connect` and
`agentrun-serve learning connect` enable setup sync. The source proves the selected machine, user and project/profile
folders match the server's context; a forwarded loopback port alone does not prove this. The server keeps publishing
complete snapshots while it runs. Existing API enrollments that do not include source consent retain their old scope.

On another machine, use the [source connector](../connector/README.md). A new `remote connect` enables sync;
`--sync-only` adds sync to an existing verified CLI capture profile without granting remote execution. Existing
connectors need a new owner-issued, connector-bound code once. Their old credential cannot grant itself export
authority. The source worker pauses and resumes when the owner changes **Keep source in sync**.

## Move the existing agent

Open the connected agent's page. Once its setup is complete and destination requirements are met, click
**Move to AgentRun**. Preparation verifies project restoration, Git and file modes before switching execution.
The agent keeps its ID, revisions and history. Existing CLI capture can continue reporting source prompts to that
same agent and its usage totals.

Model access is configured on AgentRun. A required tool connection asks you to choose its destination account;
matching an endpoint does not establish which account to use. Move refuses incomplete exports, unsupported tools
or policy, expired connections, unavailable execution environments and recorded queued, running or parked runs.
Unrecorded conversations in the original CLI are outside this admission check. The source remains usable
when preparation fails. It does not transplant an active conversation or delete source files.

After Move, use the ordinary Run, API and schedule controls. Changing harness keeps the agent's selected tools;
an incompatible harness reports the requirement rather than removing it.

## Project changes and sync conflicts

A managed run records a project checkpoint only after its tools and workspace have settled and capture succeeded.
A later run uses that committed version. Reconciliation at run end or the next new start can finish publishing a
committed candidate after restart without rerunning the task. A crash before capture is committed does not establish
a saved project. Concurrent runs cannot overwrite each other's project version: an update whose original revision
changed remains a conflict. Following up an existing run continues its retained workspace rather than starting a
new run from the current saved project.

If a run's project save is uncertain or conflicted, the agent page links its run for review. **Continue with saved
project** acknowledges only the listed receipts and permits later runs to use the current saved project. It does
not apply the unresolved changes or erase their evidence. A later failed save needs a new review. This includes a
child crash before checkpointing and a terminal claim whose journal end could not be written. Recovery reports the
missing save from the durable run and claim records; it does not reconstruct a candidate from leftover files.
An API review names the exact `entry_id`, or `entry_id: null` with `attempt_epoch` when no end exists. A previous
review or saved checkpoint cannot cover a later failed attempt. Running and queued tasks are not treated as failed
merely because their checkpoint is still pending.

Source changes continue syncing after Move. If both sides changed files or settings, automatic application pauses.
Choose **Keep AgentRun and pause sync**, or review **Use source version**. Replacing with a source snapshot retains
the previous managed revision; new source changes cannot change the version named by an open confirmation.

## Current compatibility

The source snapshot reader supports Linux. Its native capability evidence currently covers Codex 0.171.0 and
Claude Code 2.1.322 with explicit supported configurations. Account-provided tools, plugins, default catalogs and
permission behavior without a verified managed equivalent produce named prerequisites. Default native setups can
therefore sync successfully while Move still needs attention.

For Codex's file-backed sign-in, the source reads bounded local account metadata to distinguish ordinary accounts
from managed or unresolved policy. Only fixed authentication-mode and policy labels enter the snapshot; login tokens,
account identifiers and email addresses do not. This check does not refresh credentials or contact a provider. A
refresh-due, unsupported or managed account remains a prerequisite, and AgentRun still needs its own model access.

Local project storage with a separate Unix user for each run is currently unsupported: its ownership helper changes
authored file modes. Move reports this as a prerequisite rather than rewriting those modes. The server's preparation
checks its own destination; a different runner, or a runner whose configuration changed, repeats the check when it
claims the run, before changing file ownership. Separate Archil project storage does not use that local ownership
step, but still requires its own verified placement and capture capabilities.

Source OAuth credentials remain at the source. HTTP MCP accounts require explicit destination binding. Move preserves
Codex's exact tool allow/deny lists and Claude's qualified MCP selectors, including empty selections and deny precedence.
Disabled connections do not create sign-in requirements. A stdio tool, custom authentication helper or unsupported policy
still needs a verified destination equivalent.

MCP resources use the same destination account, revision pin and permission checks as tools. Servers that advertise
resources expose **List resources**, **List resource templates** and **Read resource** operations where the source
allows them. Managed AgentRun supports resource-only servers. The native acceptance checks cover a tools-capable
endpoint for Codex 0.171.0 and a true resource-only endpoint for Claude Code 2.1.322: that Codex version fails native
discovery when a server has only resources. Lists are paginated within item, byte and time limits; an incomplete
list is an error. A resource URI is passed to its pinned MCP server, never fetched directly. The names
`agentrun_list_resources`, `agentrun_list_resource_templates` and `agentrun_read_resource` are reserved within each
upstream catalog; a server declaring an ordinary tool with one of these names must rename it before connecting.
Later catalog additions do not grant new tools to an existing revision. Changed destination credentials or catalogs
require the source binding to be checked again before a new Move.

The live acceptance scope and its evidence must be checked for the selected source configuration and destination;
support for local projects does not establish live Archil compatibility or general native-tool portability.

Aliased or unresolved models are not guessed. Authored skills include
their actual scripts, binary assets and executable modes; automatically learned notes and skills remain retired.
Owner corrections and checked workflows follow the current server-side learning model and the agent's learning
settings. Eligible runs can supply examples for workflow compilation; replay checks must pass before a proposed
workflow can serve later requests. Background replay and audit runs receive isolated project copies from their
reserved revision, with its disk and learning-reset guards. They do not add turns to the original connected CLI.

Auxiliary runs must settle their project operations before finishing. Their successful project receipt is
`discarded`: run results and learning evidence are retained, but their file changes never replace the agent's saved
project. Uncertain operations retain their recovery evidence and source write receipts. Existing audit eligibility
still applies: agents with write-capable tools do not receive automatic shadow audits. Moving an agent does not
promise that every run produces a workflow or that every proposed workflow passes its checks.

Snapshot limits, unsupported Git staging/submodules/filters, links, missing instruction layers, unsupported native
hooks, secret-containing content and a project changing during capture remain explicit blockers. Required agent
capabilities are not dropped to make a snapshot complete. Successfully captured project bytes are held privately in the agent's
workspace storage; execution uses the run's pinned disk.

An upload or project-placement write whose outcome cannot be verified retains a private durable write receipt.
Agent deletion refuses while such a write may still be active. Time and restart do not clear these receipts, and
**Continue with saved project** only acknowledges run checkpoints. There is currently no automatic recovery command
for source write receipts; an operator must independently confirm the original writer and remote operations have
stopped before recovering one.
