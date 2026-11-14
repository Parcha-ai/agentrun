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

## Validation

```sh
uv pip install --python /path/to/venv/python './connector[test]'
PYTHONPATH=connector/src /path/to/venv/python -m unittest discover -s connector/tests -v
```

Tests use synthetic local peers and fixtures. The optional Collector integration test requires its external test binary; no live agent account or model call is required.

Polling sequence checkpoints persist across disconnects and destination changes; pending metadata is still discarded at those boundaries. The receiver can retain a session's last sequence across re-enrollment, so only the next fresh observation is sent with a higher sequence. Upgrades seed this checkpoint from existing local session rows before clearing them. A checkpoint already erased by an older version cannot be reconstructed locally: if an earlier destination cycle already caused updates to be ignored, reconnect with a separate state directory (a new installation identity). Invalid or exhausted checkpoints also require a separate state directory; they never wrap or reset.
