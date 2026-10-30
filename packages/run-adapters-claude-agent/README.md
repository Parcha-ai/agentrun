# @parcha/agentrun-harness-claude

The Claude Agent SDK as an AgentRun harness (adapter id `claude-agent`): a DSL `agent` node runs on the Claude Agent CLI
through `@parcha/agentrun-kernel`, durable in AgentRun's own store, with the host's tools as its only tools.

The host brings the SDK: `@anthropic-ai/claude-agent-sdk` is an exact optional peer dependency (0.3.286, whose CLI is
2.1.286), used under Anthropic's terms, and this package never ships it. Install it with its optional dependencies (they
carry the CLI for your platform), or load it where your runtime installed it and pass it in.

```ts
import { createHarnessRunner } from "@parcha/agentrun-kernel";
import { claudeAgentAdapter } from "@parcha/agentrun-harness-claude";

const runNode = createHarnessRunner(
  claudeAgentAdapter({
    model: "claude-sonnet-4-5",
    provider: { origin: "https://api.anthropic.com", credential: () => process.env.ANTHROPIC_API_KEY! },
    sessionsDir: "/var/lib/my-host/claude-agent-sessions",
    // Optional: the SDK module and its CLI from where the host installed them (checked against the pins).
    // sdk, sdkVersion, cliPath,
  }),
  { store, tools },
);
```

- **Pinned, and checked.** Making the adapter checks the SDK's version and the CLI's sha256 and version against the
  pins; a mismatch throws `ClaudeAgentPinMismatch` (which pin, expected, found), and a missing SDK or CLI throws
  `ClaudeAgentNotInstalled` ("Claude Agent SDK not installed"). An SDK that starts the CLI as another release is refused
  before the CLI starts.
- **The host's tools only.** The CLI's built-in tools are off. The host's tools are its only tools, served in-process
  and named back to the host's own names; each call is a kernel effect whose intent is recorded before it runs, so a
  call a crash cut off is reported, never repeated. A `PreToolUse` hook denies every other call, and every error inside
  it is a deny. Sub-agents, scheduled jobs, worktrees, background shells, settings, plugins and MCP servers from
  settings are off by option, and `test/tool-off.test.mjs` runs the pinned CLI against a scripted model that tries each
  of them: nothing runs, writes or fetches.
- **The model behind a proxy.** The CLI talks to a model proxy on the loopback interface with a key of its session's
  own; it never holds the provider key, a sign-in or the operator's settings. The proxy (`@parcha/agentrun-kernel/host`
  with this package's Anthropic policy) forwards only the routes the pinned CLI calls, fixes the model, refuses
  provider-hosted tools and anything the provider would run or fetch on its own, offers the model only the session's
  tools, and asks the runner before every paid request. Every paid request is booked once; the runner alone accounts
  spend.
- **A private, empty machine.** A session runs in its own directories with an empty working directory. The CLI's
  environment is an allowlist (`PATH`, `LANG`, `TZ`, its own homes and the proxy's address and key).
- **Durable.** The CLI's transcript is mirrored into the session's records (the SDK's session store), so a session a
  process died inside resumes from them on any machine.

`./testing` has a scripted Agent SDK (no CLI, key or network) and a scripted Anthropic Messages API for the real CLI.

Code this package copies from another project is listed in `vendor/durable-harness/UPSTREAM.json` and credited in
[NOTICE](NOTICE).
