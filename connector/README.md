# AgentRun source observer

This is the existing AgentRun Python CLI for explicit metadata observation of sessions that an existing terminal, backend or job queue already starts. It supports hosted AgentRun's connector protocol. It does not take over execution or import agent definitions.

This development CLI is installed from a reviewed source checkout and requires Python 3.12+:

```sh
uv tool install ./connector
agentrun discover
agentrun connect --origin https://your-console.example
```

Choose only the sessions, projects or harness subscriptions to observe. The CLI prompts for the destination API key, exchanges it for a connector-scoped credential, and retains only that scoped credential. For unattended enrollment, `--credential-file` accepts an origin-bound JSON file containing `origin` and `api_key`, owned by the source user and mode 0600; `--credential-env` names a securely injected environment variable. Never put credentials in a prompt, URL or command argument. Remove temporary enrollment material after successful connection.

Polling uses the existing observer daemon. For native telemetry, `agentrun setup --target deployment` describes the externally supervised Collector configuration. Review generated private configuration and harness fragments before applying them to a new harness process. Preserve the application's prompts, tools, permissions, existing hooks and tracing destination. A separate Collector needs a reachable receiver; generated fragments default to loopback.

`agentrun status` reports local state. Verify delivery at the destination too. `agentrun daemon stop` stops the polling daemon; an external Collector must be stopped through its supervisor. `agentrun disconnect` revokes the connection. Keep its state directory private and persistent, and supply `--state-dir` to select a separate observer installation.

For remote execution, also install the matching Node runtime (Node 24.22.3+). The installed `agentrun-serve remote-bridge` command provides the local native bridge. A checkout can use `--bridge /absolute/path/to/packages/serve/dist/native/remote-worker-bridge.js`. This source-owned executable path is never supplied by the destination.

## Connect an existing setup

Create a short-lived enrollment token through the authenticated OSS API at `POST /v2/connectors/enrollment`. On the source machine:

```sh
agentrun remote discover --project /work/project --runtime claude-code
agentrun remote connect --origin https://your-console.example \
  --project /work/project --runtime claude-code \
  --state-dir /private/project-connector
```

`remote connect` asks for the token without displaying it, then imports the selected setup and starts an outbound worker. For Codex use `--runtime codex`. Select a discovered named agent with `--selector-kind agent --selector-name NAME`, or a Codex profile with `--selector-kind profile --selector-name NAME`. Without those flags the exact project is selected. Discovery never scans or imports historical sessions.

For automation, supply a private mode-0600 file owned by the source user containing two JSON fields: `origin` for the exact destination origin and `api_key` for the enrollment token using `--credential-file /private/enrollment.json --yes`. The enrollment credential is not retained. State contains only the connector-scoped credential and the locally approved target. Never put a token in a prompt, URL or command argument.

The imported agent uses ordinary AgentRun revisions and learning controls. Turn on self-improvement in the destination, run a task, inspect its checked/graded learning in Learning Dojo, then start a fresh run. The worker delivers the pinned notes and skills additively; original instructions, MCP configuration and credentials remain on the source machine. Skills are materialized under a private per-run directory, never copied over project files. Reflection and grading use the same native signed-in runtime; they are additional model calls.

## Choose live runs, history, or both

Choose the same capabilities in the authenticated `POST /v2/connectors/enrollment` request and on the source machine. The server grants a maximum capability; the source CLI must explicitly opt in too.

```sh
# Preview only the selected project/runtime. No enrollment or upload.
agentrun remote history-preview --project /work/project --runtime codex

# History only: no native launch, worker, model calls, or automatic learning.
agentrun remote connect --origin https://your-console.example \
  --project /work/project --runtime codex --history-only \
  --state-dir /private/project-history

# Both: selected historical conversations plus live runs.
agentrun remote connect --origin https://your-console.example \
  --project /work/project --runtime codex --history \
  --state-dir /private/project-connector

# Refresh history for the exact target already approved in this state.
agentrun remote import-history --state-dir /private/project-connector
```

Without a history flag, connection enables live runs only. `--history` and `--history-only` require project selection: native logs cannot reliably attribute conversations to a named Claude agent or Codex profile. Select project history separately from a named setup’s live connection.

Only ended, settled conversations from that project and runtime are exported. Recent active files, child sessions and oversized sessions are skipped; source previews and import receipts report skipped counts. The source scans for secrets before sending bounded pages. Repeating `remote import-history` preserves stable source session IDs, so the server deduplicates previous imports. Imported history stays historical; turn on self-improvement separately for future live runs.

A history-only connector cannot launch a worker or upgrade itself to execute. Create a fresh live enrollment and a separate private state directory to enable execution later. If an upload stops partway through, run `remote import-history` again for the same state; already imported sessions are retained.

## Worker lifecycle

```sh
agentrun remote status --state-dir /private/project-connector
agentrun remote worker --state-dir /private/project-connector --foreground
agentrun remote disconnect --state-dir /private/project-connector
```

`--no-start` on connect saves/imports the setup without starting the worker. A foreground worker is suitable for an existing service supervisor; no system service is installed automatically. `remote worker` without `--foreground` starts a detached worker. The lock, not a stale PID file, determines whether one is running. Revoking the connector through the owner API or disconnecting it stops execution at the next poll. Keep the source state directory private and persistent. A new destination or replacement connector uses a new state directory.

Remote execution shares the task prompt, results, tool activity, token usage and bounded standing-instruction evidence needed for learning. It is not metadata-only observation. Only locally selected targets may execute; the destination cannot choose an arbitrary directory, binary or environment. Native permissions remain in force. Interactive approval cannot be answered by this bridge, so the run fails visibly and must be continued in the native CLI.

Commands carry renewable leases and deadlines. Losing a lease, revocation, cancellation or timeout stops source children. Dispatch is journaled before a model call; an interrupted call is not automatically replayed. A server restart, source crash or lost acknowledgement can therefore produce an explicit unknown outcome rather than a duplicate side effect. Inspect the native project before retrying. Historical conversations are transferred only when explicitly selected using the history options above. A live connection does not import them by default.

## Validation

```sh
uv pip install --python /path/to/venv/python './connector[test]'
PYTHONPATH=connector/src /path/to/venv/python -m unittest discover -s connector/tests -v
```

Tests use synthetic local peers and fixtures. The optional Collector integration test requires its external test binary; no live agent account or model call is required.

Polling sequence checkpoints persist across disconnects and destination changes; pending metadata is still discarded at those boundaries. The receiver can retain a session's last sequence across re-enrollment, so only the next fresh observation is sent with a higher sequence. Upgrades seed this checkpoint from existing local session rows before clearing them. A checkpoint already erased by an older version cannot be reconstructed locally: if an earlier destination cycle already caused updates to be ignored, reconnect with a separate state directory (a new installation identity). Invalid or exhausted checkpoints also require a separate state directory; they never wrap or reset.
