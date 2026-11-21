# AgentRun source connector

This is the existing AgentRun Python CLI with an opt-in OSS remote execution mode. The default `connect`, `discover`, `daemon` and telemetry commands observe existing sessions on either a compatible OSS server or hosted AgentRun. `remote` imports the selected native setup as an AgentRun agent and allows the destination to run it on its source machine.

This development CLI is not the currently published npm release. Install it from the same reviewed source checkout as the OSS server. Python 3.12+ and Node 24.22.3+ are required; live execution also needs the source machine’s existing signed-in Claude Code or Codex CLI. History-only import reads the selected project’s local logs without requiring native sign-in.

```sh
uv tool install ./connector
npm run build
```

The installed `agentrun-serve remote-bridge` command supplies native discovery, launch and learning through the existing AgentRun runtime. When working from a checkout instead of an installed runtime, pass `--bridge /absolute/path/to/packages/serve/dist/native/remote-worker-bridge.js` to discovery, connection or worker commands. This is a local executable path chosen by the source-machine operator; it is never supplied by the remote server.

## Observe agents that already run elsewhere

Use ordinary `connect` when a terminal, backend, Docker deployment or job queue already starts the agent. The OSS
server accepts the same metadata and OpenTelemetry protocol as hosted AgentRun. It records reported activity,
harness, model and token usage without taking over execution or importing the agent definition. No model key or
Node remote bridge is needed for observation. Choose `remote connect` below when AgentRun should start new jobs.

For native telemetry in a deployment, install this Python connector in the source environment and configure a
Collector using the existing command:

```sh
agentrun setup --target deployment
agentrun connect --origin https://your-console.example --workspace-id local \
  --telemetry --subscribe-harness claude --name "Backend agent" \
  --state-dir /private/agent-observer
```

The OSS workspace is `local`; hosted destinations use the workspace returned by their authenticated identity.
The CLI securely prompts for the destination's API key, exchanges it for a connector-scoped credential, and
retains only that scoped credential. OSS uses API-key enrollment, not hosted device sign-in. An unattended
installation may use `--credential-file` with a mode-0600, source-user-owned JSON file containing `origin` and
`api_key`, or `--credential-env` naming a securely injected environment variable. Never put the credential in a
prompt, URL or command argument. Remove temporary enrollment material after successful connection.

Review the generated private Collector configuration, harness environment and hook fragments. Deploy the
Collector through the source environment's supervisor, then apply the log-specific environment to a **new**
harness process. For a backend SDK, configure the actual child execution environment and merge lifecycle hooks
with existing hooks; preserve the application's tools, prompts, permissions and tracing destination. A separate
Collector needs an explicitly reachable receiver; generated fragments default to loopback. `--subscribe-harness
codex` selects Codex instead. Keep the connector state and Collector queue across container replacement.

For existing local sessions, use `agentrun discover`, then ordinary `agentrun connect` to select only the sessions,
projects or harness subscriptions you want. This polling mode runs the existing observer daemon. OTLP mode uses
the externally supervised Collector instead; `daemon stop` does not stop that Collector.

On a receiver advertising `token_usage.polling: true`, existing local Codex sessions also report token usage
without changing or restarting Codex. The observer reads only native session identity, model and cumulative
counter metadata from bounded local rollout tails; conversation content stays local. Existing totals establish
a baseline, then new input, output, cache-read and cache-write increments retain their source UTC dates. Input
already includes cache tokens. Polling does not backfill lifetime totals. Missing counters remain unknown;
rotation, truncation or a tail gap establishes a fresh baseline, and dropped delivery events mean partial
coverage. Native usage checkpoints and outgoing events commit together so retries do not double count.
Selected failed sessions remain eligible for final counter reads, including counters flushed after the failure;
repeated polls and daemon restarts retain the checkpoint and do not repeat reported usage.

Receivers advertising `session_labels: true` also receive bounded native session titles and project basenames
for the selected sessions. Delegated sessions can use their native task basename and nickname. Conversation
previews, prompts and full paths are never used as labels; unsafe names fall back to a harness label and a stable
ID suffix. An idle session's renamed title is refreshed without waiting for its activity to change. Older receivers
continue receiving the original activity metadata, without these additional fields.

Receivers advertising `cli_learning.session_association: true` can also show learning status beside an
observed session. The source checks the exact project (or an enclosing project) and runtime against existing
AgentRun hook receipts, configuration and a private connection for the same server. It signs the association
with that connection's scoped credential; credentials, full paths and raw native session IDs are not sent.
Configuration alone does not establish activation: the receiver must have a hook receipt from that same
native session before reporting learning on. Missing setup, unreadable configuration and delegated sessions
are reported separately. This status check never installs hooks, enrolls a project or reads conversation history.

Upgrade the receiver before enabling new connector metadata. Before rolling the receiver back to a version
without this capability, drain pending events through a compatible receiver. Pending events retain their exact
payloads for safe retries; an older receiver cannot accept those fields, even though new observations omit them
when the capability is absent.

A Codex harness or project subscription follows loaded sessions, including delegated and exec agents, before
bounded history discovery. An explicitly selected historical session remains selectable. A loaded idle session
is not reported as running, and an unavailable native interface does not prove the agent finished. The local
observer reads at most 32 MiB of counter data per poll, rotating among loaded sessions on busy machines.

Open **Connected agents**, **Runs** or **Mission Control** to inspect observed sessions. Verify a real activity or
usage receipt at the destination; local CLI status alone does not prove Collector delivery. Sessions remain
read-only: idle does not prove a job completed, and a missing heartbeat is not a model failure. Stop the Collector
through its supervisor to pause telemetry. `agentrun disconnect --state-dir /private/agent-observer` stops local
observation and prompts for a fresh OSS owner credential to revoke the connection. The restricted connector
credential cannot authorize its own remote revocation. For authorized unattended disconnection, provide a fresh
private origin-bound owner credential file (the same `origin`/`api_key` format and ownership rules as enrollment):

```sh
agentrun disconnect --state-dir /private/agent-observer \
  --credential-file /private/disconnect-owner.json --yes
```

Alternatively, with the owner credential securely injected as `AGENTRUN_OWNER_KEY`, specify the same destination
origin used to connect:

```sh
agentrun disconnect --state-dir /private/agent-observer \
  --origin https://your-console.example --credential-env AGENTRUN_OWNER_KEY --yes
```

Replace the example origin with your connected destination; the variable name is passed, never its value. Require the result's
`status` to be `disconnected` before treating remote revocation as complete. `revocation_pending` means local
observation stopped but the destination has not confirmed revocation; correct authentication or connectivity and
retry. Remove temporary owner credential material afterward. Successful revocation preserves received history
and refuses further ingestion with the old connector credential.

The OSS receiver accepts Collector HTTP/JSON logs, including bounded gzip, and advertises its formats at
`/api/v2/control/connectors/capabilities`. It retains deduplication receipts for seven days, shows session activity
for 90 days and keeps usage buckets for 90 days after the bucket’s UTC day ends (source day for polling increments, received day for OTLP). A stale session's internal
record remains only while its accepted usage still needs it; cleanup runs at startup and every minute, including
for revoked connections. Older event timestamps cannot recreate expired receipts or count tokens twice. Each
connector accepts up to 2,000 new events per minute, 100,000 receipts in the rolling window and 1,000 retained
sessions; the server allows 100 connectors. Capacity refusal is visible and supplies retry guidance instead of
silently dropping deduplication records. The console reads observations through authenticated `/v2/observations`.

Observation does not inject lessons into subsequent backend jobs. For checked self-improvement while your
application keeps starting jobs, use the [Claude Agent SDK](../docs/tutorials/claude-sdk-learning.md) or
[Codex SDK](../docs/tutorials/codex-sdk-learning.md) integration and verify accepted learning on a fresh run.
The current SDK wrappers are TypeScript integrations; observing a Python SDK process does not install one.

## Connect an existing setup

In the OSS console, choose **Connect agent → Another machine** and create a short-lived enrollment token. On the source machine:

```sh
agentrun remote discover --project /work/project --runtime claude-code
agentrun remote connect --origin https://your-console.example \
  --project /work/project --runtime claude-code \
  --state-dir /private/project-connector
```

`remote connect` asks for the token without displaying it, then imports the selected setup and starts an outbound worker. For Codex use `--runtime codex`. Select a discovered named agent with `--selector-kind agent --selector-name NAME`, or a Codex profile with `--selector-kind profile --selector-name NAME`. Without those flags the exact project is selected. Discovery never scans or imports historical sessions.

For automation, supply a private mode-0600 file owned by the source user containing two JSON fields: `origin` for the exact destination origin and `api_key` for the enrollment token using `--credential-file /private/enrollment.json --yes`. The enrollment credential is not retained. State contains only the connector-scoped credential and the locally approved target. Never put a token in a prompt, URL or command argument.

The imported agent uses ordinary AgentRun revisions and learning controls. Turn on self-improvement in the destination and edit the owner's standing corrections in Learning. The worker supplies the pinned corrections to later runs; original instructions, authored skills, MCP configuration and credentials remain on the source machine. Native connections do not generate automatic notes or skills, compile learned workflows, or launch extra reflection sessions.

## Choose live runs, history, or both

Choose the same scope in the console enrollment dialog and on the source machine. The server grants a maximum capability; the source CLI must explicitly opt in too.

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

`--no-start` on connect saves/imports the setup without starting the worker. A foreground worker is suitable for an existing service supervisor; no system service is installed automatically. `remote worker` without `--foreground` starts a detached worker. The lock, not a stale PID file, determines whether one is running. Revoking the connector from the console or disconnecting it stops execution at the next poll. Keep the source state directory private and persistent. A new destination or replacement connector uses a new state directory.

Remote execution shares the task prompt, results, tool activity, token usage and bounded standing-instruction evidence needed for learning. It is not metadata-only observation. Only locally selected targets may execute; the destination cannot choose an arbitrary directory, binary or environment. Native permissions remain in force. Interactive approval cannot be answered by this bridge, so the run fails visibly and must be continued in the native CLI.

Commands carry renewable leases and deadlines. Losing a lease, revocation, cancellation or timeout stops source children. Dispatch is journaled before a model call; an interrupted call is not automatically replayed. A server restart, source crash or lost acknowledgement can therefore produce an explicit unknown outcome rather than a duplicate side effect. Inspect the native project before retrying. Historical conversations are transferred only when explicitly selected using the history options above. A live connection does not import them by default.

## Validation

```sh
uv pip install --python /path/to/venv/python './connector[test]'
PYTHONPATH=connector/src /path/to/venv/python -m unittest discover -s connector/tests -v
node --test packages/serve/test/remote-worker-bridge.test.mjs
```

Tests use local synthetic network peers and native CLI fixtures, never paid models or user session data. The Collector integration test requires its external test binary. Live verification is a separate opt-in exercise against a selected destination and source project.

Polling sequence checkpoints persist across disconnects and destination changes; pending metadata is still discarded at those boundaries. The receiver can retain a session's last sequence across re-enrollment, so only the next fresh observation is sent with a higher sequence. Upgrades seed this checkpoint from existing local session rows before clearing them. A checkpoint already erased by an older version cannot be reconstructed locally: if an earlier destination cycle already caused updates to be ignored, reconnect with a separate state directory (a new installation identity). Invalid or exhausted checkpoints also require a separate state directory; they never wrap or reset.

Changing approved selections discards pending observations for removed or changed selections before saving the new consent, even with `--no-start`. Selecting that source again produces a fresh observation with a higher sequence; it does not restore the discarded payload. Still-selected sources retain their pending observations.

Polling allocates session IDs only for selected sessions or explicit future subscriptions. The local identity and project maps each hold at most 4,096 entries. At that limit, known selected sessions keep reporting activity and discovery reports a partial result; future sessions that cannot receive an ID are skipped. Use a separate state directory to observe additional sources. Observation of a session's new directory does not allocate an enrollable project choice.

An explicitly named `--credential-env` variable is consumed by that CLI invocation before launching any child process. Harness discovery and the detached observer inherit the other source authentication and configuration variables, but not that enrollment secret.
