# Sync a connected agent and move it to AgentRun

New source connections keep setup sync on by default. Sync copies the selected project's instructions, authored
skills and their assets, supported settings, tool requirements, project files and bounded Git history. It does not
copy native sign-in credentials or import past conversations. The connection command describes the scope before
export; `--no-sync` connects without exporting setup.

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
not apply the unresolved changes or erase their evidence. A later failed save needs a new review.

Source changes continue syncing after Move. If both sides changed files or settings, automatic application pauses.
Choose **Keep AgentRun and pause sync**, or review **Use source version**. Replacing with a source snapshot retains
the previous managed revision; new source changes cannot change the version named by an open confirmation.

## Current compatibility

The source snapshot reader supports Linux. Its native capability evidence currently covers Codex 0.171.0 and
Claude Code 2.1.322 with explicit supported configurations. Account-provided tools, plugins, default catalogs and
permission behavior without a verified managed equivalent produce named prerequisites. Default native setups can
therefore sync successfully while Move still needs attention.

Source OAuth credentials remain at the source. HTTP tool accounts require explicit destination binding; a stdio
tool needs a verified destination equivalent. Aliased or unresolved models are not guessed. Authored skills include
their actual scripts, binary assets and executable modes; automatically learned notes and skills remain retired.
Owner corrections and checked workflows follow the current learning model. Auxiliary audit/replay runs that need
their own moved-project placement are refused until that placement is supported. New audit/replay promotion checks
do not run for moved agents; owner learning settings, corrections and existing checked workflows are retained.

Snapshot limits, unsupported Git staging/submodules/filters, links, missing instruction layers, unsupported native
hooks, secret-containing content and a project changing during capture remain explicit blockers. Nothing is
silently dropped to make a snapshot complete. Successfully captured project bytes are held privately in the agent's
workspace storage; execution uses the run's pinned disk.

An upload or project-placement write whose outcome cannot be verified retains a private durable write receipt.
Agent deletion refuses while such a write may still be active. Time and restart do not clear these receipts, and
**Continue with saved project** only acknowledges run checkpoints. There is currently no automatic recovery command
for source write receipts; an operator must independently confirm the original writer and remote operations have
stopped before recovering one.
