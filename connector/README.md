# AgentRun source connector

This is the existing AgentRun Python CLI with an opt-in OSS remote execution mode. The default `connect`, `discover`, `daemon` and telemetry commands retain their metadata-only hosted observer behavior. `remote` is separate: it imports the selected native setup as an AgentRun agent and allows the destination to run it on its source machine.

This development CLI is not the currently published npm release. Install it from the same reviewed source checkout as the OSS server. Python 3.12+ and Node 24.22.3+ are required; the source machine also needs its existing signed-in Claude Code or Codex CLI.

```sh
uv tool install ./connector
npm run build
```

The installed `agentrun-serve remote-bridge` command supplies native discovery, launch and learning through the existing AgentRun runtime. When working from a checkout instead of an installed runtime, pass `--bridge /absolute/path/to/packages/serve/dist/native/remote-worker-bridge.js` to discovery, connection or worker commands. This is a local executable path chosen by the source-machine operator; it is never supplied by the remote server.

## Connect an existing setup

In the OSS console, choose **Connect existing agents → Another machine** and create a short-lived enrollment token. On the source machine:

```sh
agentrun remote discover --project /work/project --runtime claude-code
agentrun remote connect --origin https://your-console.example \
  --project /work/project --runtime claude-code \
  --state-dir /private/project-connector
```

`remote connect` asks for the token without displaying it, then imports the selected setup and starts an outbound worker. For Codex use `--runtime codex`. Select a discovered named agent with `--selector-kind agent --selector-name NAME`, or a Codex profile with `--selector-kind profile --selector-name NAME`. Without those flags the exact project is selected. Discovery never scans or imports historical sessions.

For automation, supply a private mode-0600 file owned by the source user containing two JSON fields: `origin` for the exact destination origin and `api_key` for the enrollment token using `--credential-file /private/enrollment.json --yes`. The enrollment credential is not retained. State contains only the connector-scoped credential and the locally approved target. Never put a token in a prompt, URL or command argument.

The imported agent uses ordinary AgentRun revisions and learning controls. Turn on self-improvement in the destination, run a task, inspect its checked/graded learning in Learning Dojo, then start a fresh run. The worker delivers the pinned notes and skills additively; original instructions, MCP configuration and credentials remain on the source machine. Skills are materialized under a private per-run directory, never copied over project files. Reflection and grading use the same native signed-in runtime; they are additional model calls.

## Worker lifecycle

```sh
agentrun remote status --state-dir /private/project-connector
agentrun remote worker --state-dir /private/project-connector --foreground
agentrun remote disconnect --state-dir /private/project-connector
```

`--no-start` on connect saves/imports the setup without starting the worker. A foreground worker is suitable for an existing service supervisor; no system service is installed automatically. `remote worker` without `--foreground` starts a detached worker. The lock, not a stale PID file, determines whether one is running. Revoking the connector from the console or disconnecting it stops execution at the next poll. Keep the source state directory private and persistent. A new destination or replacement connector uses a new state directory.

Remote execution shares the task prompt, results, tool activity, token usage and bounded standing-instruction evidence needed for learning. It is not metadata-only observation. Only locally selected targets may execute; the destination cannot choose an arbitrary directory, binary or environment. Native permissions remain in force. Interactive approval cannot be answered by this bridge, so the run fails visibly and must be continued in the native CLI.

Commands carry renewable leases and deadlines. Losing a lease, revocation, cancellation or timeout stops source children. Dispatch is journaled before a model call; an interrupted call is not automatically replayed. A server restart, source crash or lost acknowledgement can therefore produce an explicit unknown outcome rather than a duplicate side effect. Inspect the native project before retrying. Remote connection imports the selected setup and its future runs; bulk historical transcript import is separate and is not performed.

## Validation

```sh
uv pip install --python /path/to/venv/python './connector[test]'
PYTHONPATH=connector/src /path/to/venv/python -m unittest discover -s connector/tests -v
node --test packages/serve/test/remote-worker-bridge.test.mjs
```

Tests use local synthetic network peers and native CLI fixtures, never paid models or user session data. Live verification is a separate opt-in exercise against a selected destination and source project.
