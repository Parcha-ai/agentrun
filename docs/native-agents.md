# Connect existing Claude Code and Codex agents

Connect an existing setup on the same machine as a loopback AgentRun server using the native CLI commands below. Select the project default, a Claude Code named agent, or a Codex profile. Verification checks the installed CLI and native sign-in without a model call; model and tool execution remain untested until a job runs.

The current bridge requires stable Claude Code 2.1.322 or later in major version 2, or Codex 0.167.2 or later in major version 0. Older, prerelease and other major versions show Needs attention until the bridge supports their protocol.

The public CLI provides the same handoff:

```sh
npx @parcha/agentrun native discover --project /absolute/project
npx @parcha/agentrun native connect --project /absolute/project --runtime claude-code
npx @parcha/agentrun native connect --project /absolute/project --runtime codex --profile review
```

Use `--agent NAME` for a discovered Claude named agent. Use `--data DIR` for another local instance, or `--url http://127.0.0.1:PORT`. Discovery runs metadata commands only. Local connection needs the local server credential; it needs no model API key. A browser cannot scan another machine.
