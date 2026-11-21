# Learn from existing Codex CLI and Claude Code sessions

Keep starting your coding agent normally. AgentRun's project-scoped hooks can record completed
prompt windows and reported usage, and return owner corrections when you submit a later prompt.
You do not need an SDK wrapper or an AgentRun-launched task.

This is different from metadata observation. Observation reports activity and usage without task
contents. The hooks send bounded task evidence to the local AgentRun server and return the corrections
you explicitly save in the agent's Learning tab. They do not import earlier conversations or turn
task dialogue into standing instructions.

## Connect a project

Use the CLI from the same build as the server, on the machine where your coding agent runs. The
initial integration requires a local server: verify its loopback address and actual data directory.
Keep the server data directory outside the source project; it contains private connection credentials.
This source-hook connection does not make extra model calls to your native CLI. Its hooks do not
provide the executable tool bridge needed for AgentRun's checked workflow learning.

```sh
agentrun-serve learning connect --project /absolute/project --runtime codex \
  --url http://127.0.0.1:7340 --data /absolute/server-data

agentrun-serve learning connect --project /absolute/project --runtime claude-code \
  --url http://127.0.0.1:7340 --data /absolute/server-data
```

Choose one runtime, or run both commands to connect both. The public `npx @parcha/agentrun learning`
command forwards to the same implementation. Keep credentials in local configuration; never paste
a key into a prompt or pass one as a command argument. Enrollment uses the local owner's credential;
installed hooks read a private credential scoped to this learning connection from server data.
Neither the project hook file nor the install receipt contains the credential.

Installation merges hooks with your existing configuration. It does not replace your other hooks,
instructions, skills, MCP servers, model choices, permissions or sign-in.

In linked Git worktrees, Codex 0.171 loads hook declarations from the corresponding directory in
its main checkout. AgentRun therefore appends each enrolled project's hooks to that shared
`.codex/hooks.json`, with the command still scoped to its original project and runtime. A shared lock
serializes installs and disconnects. No dispatcher or project configuration override is installed;
worktree-local TOML and unrelated hooks stay unchanged. Each worktree retains its own local install
receipt, and its `.codex` directory must remain present for native discovery. Claude continues to use
`.claude/settings.local.json`.

If `learning status` reports `migration-required`, run the same `learning connect` command again.
It moves only unchanged AgentRun-owned hooks from the ignored worktree-local JSON file into the shared
file, keeping the existing learning connection and credential. Modified hooks or invalid Git ownership
stop migration without replacing configuration. If migration was interrupted, `learning disconnect`
can remove both owned representations.

Codex trust keys include hook array positions. Disconnect leaves empty groups before surviving groups
so their keys stay stable. If a user added another handler inside an owned group, disconnect still
removes the AgentRun handler and preserves the user's handler, but warns that the edited group's
remaining trust keys need review in `/hooks`.

### Already-running sessions

Check `/hooks` in the source CLI after installation. Codex requires trust for the current hook
definition; installation does not grant that trust. Codex does not hot reload already-loaded project
configuration: open a new session, or close and resume the existing session, before checking `/hooks`
again. Reloading user configuration alone does not reload project hooks. Claude Code normally picks
up settings changes through its watcher. Verify activation rather than assuming a file edit attached
the hook. Do not interrupt a task already in progress just to reload configuration.

Learning begins with the next complete prompt after activation. A turn already in progress at
installation is not learned retroactively. If the source cannot supply complete policy or task
evidence, AgentRun records the limitation with the run.
Tested hook contracts are Codex 0.169.0/0.171.0 and Claude Code 2.1.322; older versions may require an upgrade.

## What happens on a prompt

1. The prompt hook opens a run and receives a pinned revision of owner corrections from
   `corrections.md`. Guidance is returned through the CLI's supported context hook.
2. Your CLI executes the task with its original tools and permissions.
3. A completion hook sends bounded evidence with user and assistant roles preserved, plus reported
   token usage when it can be attributed to this prompt. Cancellation or missing completion is not
   success. Task dialogue, tool output and reasoning never become owner corrections automatically.
4. Save a correction explicitly in the agent's Learning tab when you want it used on future tasks.
5. A later prompt can receive that revision. The run records whether the native transcript confirms
   receipt of the pinned guidance; a successful HTTP response alone is not proof of delivery.

AgentRun's current learning model is owner corrections and checked workflows. This source-hook
integration delivers corrections only: it has no workflow execution bridge. It does not generate
notes or skills, convert old automatic notes into owner corrections, or launch separate native
reflection sessions. Historical notes and skills stay on disk but are not served as guidance.
Existing CLI profiles stored with the retired `learning: "notes"` setting read as enabled under the
current model; their old revisions and files are not rewritten by a read.

A task that depends on images or other uncaptured media is marked incomplete. Each captured prompt
has a 24-hour completion deadline; a later receipt cannot revive an expired run or infer a successful
outcome. AgentRun's availability must not block normal coding; inspect learning status after an
outage rather than assuming every prompt was recorded.

Capture is bounded: policy is limited to 256 KiB, post-enrollment dialogue history to 64 KiB,
and the transcript scanned for one prompt to 64 MiB.
If a session exceeds the supported evidence limits, capture reports incomplete evidence. Starting
a new session keeps the project's owner corrections available. Source tool outputs and private reasoning are not uploaded as conversation.
The initial policy scan of a long-running session may take several bounded checkpoints before
learning becomes available. Claude's native loaded instructions include imported files. If those
instructions change during a task, that prompt is recorded with incomplete policy instead of
claiming its policy was captured completely.

## Inspect or disconnect

```sh
agentrun-serve learning status --project /absolute/project --runtime codex \
  --url http://127.0.0.1:7340 --data /absolute/server-data

agentrun-serve learning disconnect --project /absolute/project --runtime codex \
  --url http://127.0.0.1:7340 --data /absolute/server-data
```

Use `claude-code` for a Claude connection. In the console, open the connected agent's Runs and
Learning tabs to inspect recorded work and edit owner corrections. The normal learning switch
controls guidance delivery for future prompts. Disconnect revokes enrollment and
removes only the hooks installed for this connection; existing task and learning history stays available.

Completed windows retained during an outage can be retried without duplicating runs:

```sh
agentrun-serve learning retry --project /absolute/project --runtime codex \
  --url http://127.0.0.1:7340 --data /absolute/server-data
```

Private capture journals are bound to their destination and connection credential generation.
Reconnecting with a different destination or renewed credential starts a fresh journal. Prior and
older unbound journals remain on disk and are never automatically migrated or retried under the new
connection. `learning retry` reports them as `blocked_journals`, warns that they need review, and exits
with status 1. It does not upload or delete those records.

`status` reports configuration separately from the server's last received hook and run. A configured
hook is not proof that the source CLI loaded or trusted it.

To verify the whole loop, save an owner correction in the Learning tab, then submit a new task that
can use it. Check the completed run and its guidance delivery evidence. Compare with learning off.
A connected session, accepted enrollment or idle activity alone is not evidence that capture or
guidance delivery worked.
