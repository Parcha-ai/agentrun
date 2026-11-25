# @parcha/agentrun-harness-acp

Any [Agent Client Protocol](https://agentclientprotocol.com) agent as an AgentRun harness, on the official
`@agentclientprotocol/sdk` (pinned). Private for now: the runner's harness table registers it once that table takes new
entries.

- The agent runs over stdio, in a private HOME with an environment allowlist (PATH, LANG, TZ, then what the recipe
  names), in a process group of its own that dies with the host.
- `initialize` is checked against the recipe's `declares` (`load`, `mcp`): a mismatch refuses with
  `ACP_CAPABILITY_MISMATCH`.
- The host's tools are one loopback MCP server, `agentrun`, given on `session/new`: over HTTP when the recipe declares
  it, else over stdio through a small bridge. Every call runs through the kernel's tool bridge: the host's gate, the
  call's intent in the session's records, then the tool.
- `session/request_permission` goes through the host's gate (allow, deny, park), journaled. The adapter answers
  `allow_once` or `reject_once`, never an `allow_always`, and never trusts the status ACP reports. The host's tools ask
  nothing: a recipe's `allowFile` (Goose's `.config/goose/permission.yaml`) lists them for the agent at each start, and
  the gate asks at the MCP call. A recipe that declares `quirks.permissionTie: "title"` (Cursor's, whose allowlist asks
  for every MCP call) has its request for one of the host's announced calls answered `allow_once` without the gate.
- An agent's `tool_call` is matched to the MCP call it makes by the tool and the arguments. Which tool it names is read
  from the field its recipe's `announces` declares (Goose's `_meta.goose.toolCall.toolName`, Cursor's `rawInput`, agy's `name`),
  never from its title; a call that field names as another tool is the agent's own.
- `session/load` resumes a session when the recipe declares it and the agent advertises it; the history it replays stays
  off the timeline. With no load, a crash mid-turn restarts the turn on a new agent session with the kernel's recovery
  note, and the conversation so far as a context note.
- ACP has no paid-request hook: the agent's own session store (the recipe's `state` paths) is mirrored into the
  session's records at turn end and after each finished tool call, credential files left out.
- A plan-billed agent (`billing: { kind: "plan", maxTurns, maxToolCalls }`) is stopped at the owner's limits with
  `ACP_TURN_LIMIT` or `ACP_TOOL_CALL_LIMIT`: the adapter counts `session/prompt` turns and tool calls itself.

```js
import { acpAdapter } from "@parcha/agentrun-harness-acp";

const adapter = acpAdapter({
  recipe: {
    id: "goose",
    command: "/opt/goose/bin/goose",
    args: ["acp"],
    env: { GOOSE_MODE: "approve" },
    files: { ".config/goose/config.yaml": "extensions: {}\n" },
    state: [".local/share/goose/sessions"],
    declares: { load: true, mcp: "http" },
    billing: { kind: "plan", maxTurns: 40, maxToolCalls: 200 },
  },
  sessionsDir: "/var/lib/agentrun/acp",
});
```

The tests run on a fake ACP agent (`testing/fake-acp-agent.mjs`, exported as `@parcha/agentrun-harness-acp/testing`) that plays Goose (load, MCP over HTTP, a permission
request for every tool) and Cursor (load, permission for shell and MCP but not edits), and an agent with no load.
