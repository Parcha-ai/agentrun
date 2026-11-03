# The OpenCode harness (inside AgentRun Server)

OpenCode as an AgentRun harness: AgentRun Server runs a revision with `harness: "opencode"` on OpenCode, durable in
AgentRun's own store, with the host's tools as its only tools. The adapter lives in this folder of the server and
imports only `@parcha/agentrun-kernel`, so it can move into a package of its own unchanged. Its tests are the server's
`test/opencode-*.test.mjs`.

```ts
import { createHarnessRunner } from "@parcha/agentrun-kernel";
import { openCodeAdapter } from "./harness-opencode/index.js";

const runNode = createHarnessRunner(
  openCodeAdapter({
    model: "gpt-5.4-mini",
    provider: { origin: "https://api.openai.com", credential: () => process.env.OPENAI_API_KEY! },
    sessionsDir: "/var/lib/my-host/opencode-sessions",
  }),
  { store, tools },
);
```

OpenCode is the host's install, pinned exactly: `npm install --save-exact opencode-ai@1.19.5` (an optional peer of the
server). npm installs the platform's binary as that package's own optional dependency. The adapter checks the
binary it would run when it is made: the platform package's version, the binary's sha256 for the Linux x64 builds, and
the version it reports. A mismatch is `OpenCodePinMismatch`, a missing binary `OpenCodeNotInstalled`, each naming the
install line. `OPENCODE_BIN` names a binary in place of the platform package's.

- **One `opencode serve` per drive.** Each drive of a session starts the pinned `opencode serve` on the loopback
  interface, with a password of its own, in fresh private directories (its HOME and XDG config, data, cache and state).
  It runs in the host's workspace when the host names one (`io.cwd`), else in an empty directory of the session's. Its
  environment is an allowlist: `PATH`, `LANG`, `TZ`, its own directories, its config and OpenCode's own switches (no
  autoupdate, no model list fetch, no language server download, no default plugins, no `~/.claude`, no external skills,
  no project config). Nothing else of the host's reaches it, and its process group ends with the drive.
- **The host's tools only.** Every OpenCode tool is denied, and the host's tools reach it as one MCP server of the
  adapter's own on the loopback interface, behind a key of the session's. OpenCode names them `hands_<tool>` to the
  model; every event the adapter reports uses the host's own names. Each call is a kernel effect, whose intent is
  durable before it runs, so a `never` tool a crash cut off is reported, never run again. A long call reports MCP
  progress every 15 s, so OpenCode's call timeout never ends a call that waits on a person.
- **The model behind a proxy.** OpenCode's one provider is OpenAI's Responses API at the session's model proxy, with a
  key of the session's. The proxy forwards `POST /v1/responses` only, fixes the model, stores nothing at the provider,
  refuses a provider-hosted tool and drops any function that is not the host's, and asks the runner before every paid
  request, so the turn cap and the host's budget hold. Each response's usage comes back to the runner. OpenCode's own
  agents are off, its title and summary agents among them, and the session has a title of its own, so it makes no side
  request (`test/real-opencode.test.mjs`).
- **The session's instructions.** They are the prompt of OpenCode's one agent, in place of OpenCode's own. OpenCode
  still adds its environment lines (the model's name, the working directory, the platform and the date). A host's
  `dateLine` goes in each turn's system prompt.
- **The host's skills, and no others.** `openCodeAdapter({ skills: [{ name, files }] })`: the instructions list each
  skill by name and description, and the model reads its files with `read_skill_file`. The skills are checked when the
  adapter is made (`skillProblems`).
- **Durable in the host's store.** OpenCode is event-sourced. Its events for the session (`/sync/history`) are
  mirrored into the session's records before every paid request, before every `never` tool call and at each turn's
  end. The next drive gives them back to a fresh OpenCode (`/sync/replay`), so a follow-up, a stop or a crash never
  loses a turn the records hold. A turn a crash cut off gets the kernel's recovery note as a user message, naming each
  call and how it ended.
- **Events.** A session reports exactly `text`, `tool_start` (its call id, the host's name and the whole arguments),
  `tool_end` (whether it failed, and its result text, once that is durable) and `turn_end`. The cost of a request
  comes only on the runner's booking.
- **Stop.** `interrupt()` aborts OpenCode's turn and waits up to 3 s for its end to be in the records: the next message
  is a plain turn. If it does not end in time, the drive is halted and the next turn is a recovery.

OpenCode is MIT-licensed (https://github.com/anomalyco/opencode). The server ships none of it.
