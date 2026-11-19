# Adding a harness

A harness is the loop that runs an AgentRun agent: it sends the model the conversation and runs the tool calls that
come back. AgentRun ships pi, Claude Code, Codex, OpenCode, Goose and Cursor. There are two ways to add another one
without changing AgentRun:

- **A recipe** ([below](#a-recipe)): a JSON file that says how to run an [Agent Client Protocol](https://agentclientprotocol.com)
  agent AgentRun does not ship. You write no code. Its owner installs the agent's release with one command, and
  `agentrun harness-check` runs it for real and says whether it keeps AgentRun's rules.
- **A harness module**: a small package that the server's owner installs beside the server, for an agent a recipe
  can't describe. Most of this page is about it.

The module tells serve what the harness is (its facts) and how to start it for one run. serve does the rest the way it
does for its own harnesses: which models the harness is offered, which key rows name it, what its offer says when
something is missing, how its tool calls are gated, and how each model request is booked against the run's cap.

[examples/harness-module](examples/harness-module/README.md) is a whole module. It adds Goose, an ACP agent, under an
id of its own, and this page refers to it throughout.

## The first 30 minutes

Each step ends on a command that tells you whether it is done. Run them from the repository root.

1. Watch a module pass before you write one. This runs the conformance suite on the example's harness, against a
   fake ACP agent, with no binary, no model and no key:
   `npm run test:harness-module-example`
   It is done when the last lines read `ℹ pass 25`, `ℹ fail 0` and `ℹ skipped 6`.
2. Copy `examples/harness-module` to a folder of your own and give it your package name. Change [what you
   write](#what-you-write): the id, the facts, the recipe, the proxy and `missing`.
3. Run `npm test` in your copy until it passes the same way ([prove it](#prove-it)).
4. Install it beside a server and start the server with it ([load it](#load-it)). `GET /v2/capabilities` lists your
   harness in `harnesses` after the built-in ones.
5. Run one agent on it on a real model, then [send it](#send-it).

## What you write

A module exports one function, `entries(builtins, kit)`. It returns your harness's entry under its id. serve loads the
module with `require`, so it has no top-level await. Its types come from `@parcha/agentrun-serve/harness`, which loads
nothing of serve. The server hands the module the `kit` from its own copy of serve, so your harness is built the same
way as the built-in ones on that server.

```js
export const entries = (_builtins, kit) => ({
  "goose-module": kit.acpEntry({ facts, missing, recipe, proxy, beforeStart }),
});
```

### The id

A new id that matches `^[a-z][a-z0-9-]{0,39}$`. A module can't take a built-in harness's id (`pi`, `claude-agent`,
`codex`, `opencode`, `goose`, `cursor`) or one of the ids serve's own runs carry (`learning`, `sdk`, `workflow`,
`claude-agent-sdk`, `codex-sdk`). If it does, the server refuses to start and names the module and the id.

### The facts

The facts are the kernel's `AdapterFacts`: what your harness is, stated once. serve reads them and never branches on
your harness's name. The ones that change what an owner sees:

| Fact | What serve does with it |
| --- | --- |
| `wire` | Which models the harness is offered and which key rows name it. On `anthropic-messages` that is Anthropic's models, on the Anthropic and OpenRouter key rows; on `openai-responses`, OpenAI's, on the OpenAI and OpenRouter rows. |
| `ownModel` | Set it when the harness runs only its wire's vendor's models, never the gateway's default. |
| `normalizeModel` | How the model id is written for your provider (Anthropic's ids have dashes where OpenRouter's have dots). |
| `steer` | Whether a message sent mid-turn reaches the turn in flight. ACP has no steer, so an ACP agent says `false`. |
| `rerunsStarted`, `recoversCutAnswers` | Whether a call cut off by a crash may run again, and how many answers cut at the output limit it recovers. The conformance suite reads these and skips the cases they rule out. |
| `runMib` | One run's memory, measured. A server admits as many runs as fit in its memory. |
| `hostName`, `nativeTools` | How your harness names the host's tools, and which of its own tools are held to which tool setting (an `acme_shell` held to `bash`, say). |
| `policy` | What a model request may carry and where it may go on this server's key. |
| `install` | The line that installs the harness, and the error codes its setup carries. |

The example spreads Goose's own facts and changes the id and the label. Copy those of the built-in harness that is
closest to yours, then change what differs.

### How it starts: `kit.acpEntry` or `kit.adapterEntry`

An agent that speaks ACP (the Agent Client Protocol) runs on serve's own ACP adapter, `@parcha/agentrun-harness-acp`.
Give `kit.acpEntry`:
- `recipe(launch)`: how to start the agent for one run. It holds the command, its arguments, environment and files, the
  state folders that hold its sessions, what it declares (`load`: whether it resumes with `session/load`; `mcp`:
  whether our tools reach it over `http` or `stdio`), and how it is billed (`proxy`, or `plan` with a turn and tool-call
  bound). `launch.model` is the model serve chose for the run, already written the way your provider names it.
- `proxy(launch)`: the model proxy each of the agent's processes calls. The agent never holds a key: it holds the
  proxy's own key for the session, and the proxy books each request against the run's cap, then forwards it with this
  server's key. `gooseProxy` serves any agent that reads `ANTHROPIC_HOST` and `ANTHROPIC_API_KEY`. An agent on another
  wire needs an `AcpProxy` of its own.
- `beforeStart(command)`, optional: a check before each process starts, a restart included. The example checks the
  binary against its pin there.
- `promises`, optional: what the harness promises an owner, shown on its offer. The default is a resume by
  `session/load`, each tool call through the agent's permission ask, and billing through the proxy. An agent that
  can't load a session says `resume: "restart"`.

Any other agent runs on an adapter you write (the kernel's `AgentAdapter`). Give `kit.adapterEntry(facts, adapter)`,
where `adapter(launch)` builds it for one run. `launch` holds the model, where to forward its requests
(`launch.provider`: the origin, the credential and how it is sent), the price of a request's usage, a log, the
confinement its process starts under, and the server's environment.

For either one, serve picks the model and the key the way it does for its own harnesses. A person's Claude Code login is
never a module's credential.

### What no key fixes: `missing`

Give `missing(env)` for anything a model key can't fix. Most often that is the binary. serve asks it before the key.
When it returns words, the harness's offer says them and names no key. Without it, a harness that has neither its
binary nor a key would be offered as one that a key runs. The example returns, in words that end with what to do, that
no binary is named, or that the one named isn't the pinned Goose.

Settings of your own come from the server's environment (`launch.env` and `missing`'s `env`). The example reads its
binary's path from `EXAMPLE_GOOSE_BINARY`.

## Prove it

The conformance suite is the one this repository proves its own harnesses with. It comes from
`@parcha/agentrun-serve/conformance`:
- `registerHarnessConformance(subject, { test })` registers its cases on `node:test`.
- `createAdapterLoop(spec, { restartLimit: MAX_RESTARTS })` is the kernel's adapter loop, which runs every adapter
  harness, built-in or not.
- `suiteHostTools(tools)` gives the suite's tools to your session as host tools.

The subject runs your adapter in that loop. Its cases crash the run at each point that matters and check what happens:
before a tool's intent is recorded and after it, mid-answer, with the runner process killed, and with a run paused past
its lease. A tool that changes something must run at most once; a resumed run must pick up where it was. Your facts
say which cases your harness rules out, and the suite skips each of those with the reason.

An ACP agent's module runs the suite on `@parcha/agentrun-harness-acp/testing`. `fakeAgentRecipe(id, dir, script)`
starts a fake ACP agent whose model is the suite's script. It needs no binary, no model and no key, so the suite runs
before any real agent is in it. `examples/harness-module/test/subject.mjs` is the whole subject. Keep it in a module of
its own: the suite's process cases start a second runner process that imports it.

`./conformance` is for your tests alone. `registerHarnessConformance` starts the suite's runner process from your test
process, and that runner has test hooks that read the environment. Import `@parcha/agentrun-serve/conformance` only
from test files, never from your module's own code: the server loads your module, and the suite must never run inside
a server.

What the fake can't prove is your recipe and your proxy on a real agent. That is the [live run](#a-live-run).

### What passing looks like

```
ℹ tests 31
ℹ pass 25
ℹ fail 0
ℹ skipped 6
```

Each skipped case names why your harness doesn't do it by design. For an ACP agent: no steer, no rerun of a started
call, and no recovery of an answer cut at the output limit. Any other skip, or any failure, is yours to fix.

## Load it

On the server's machine, install the module into the server's data and name it at the start:

```sh
npm install --prefix <data>/harnesses <your-package>
agentrun-serve --data <data> --harness-module <your-package>
```

`--harness-module` can be repeated, and `AGENTRUN_SERVE_HARNESS_MODULES=a,b` does the same. A module can also be a
path. A separate `agentrun-serve runner` takes the same flag and needs it to run your harness. A module that isn't
installed refuses the start and names the command that installs it.

`GET /v2/capabilities` then lists your harness in `harnesses`, after the built-in ones, with its `label`, its
`promises`, and either `available: true` and the `keys` that run it, or `available: false` and the `reason`. Loading
your module changes nothing a built-in harness is offered: its models, key rows, default model and tool names are the
same as without it. Tests in serve hold that.

### A live run

Save an agent with `definition.harness` set to your id and run it on a cheap model. Set `AGENTRUN_TELEMETRY=0` on any
server you start for testing, so your test runs don't count as users. The run's events show your harness's tool calls,
and its cost line shows the requests your proxy booked.

## Send it

A module is yours to publish: an owner installs it by package name. To have it listed here, open a pull request that
adds a row to [docs/examples.md](docs/examples.md) with:
- the conformance output above, from your module's `npm test`;
- the id and cost line of one live run, and the model it ran on;
- what your facts rule out, in a sentence.

## A recipe

A recipe fits an ACP agent that the [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
lists with a binary release packed as `.tar.bz2` or `.tar.gz`. Today a recipe is checked and installed; a server does
not yet run one as a harness of its own, so `harness-check` is the whole of this door for now. A recipe that passes it
is what that server-side step will take.

### What you need

- AgentRun's CLI and server, with the ACP adapter beside the server: `@parcha/agentrun`, `@parcha/agentrun-serve` and
  `@parcha/agentrun-harness-acp` installed in the same `node_modules`.
- The agent's entry in the ACP registry: its version and, for your platform, the archive's URL, its sha256 and the
  binary's path inside it.
- For an agent billed through AgentRun's model proxy: a model key in your environment, `OPENROUTER_API_KEY` or
  `ANTHROPIC_API_KEY`. The agent never sees it.
- Linux, for the full check: the agent's environment is read from `/proc`.

### Field by field

A recipe is one JSON object. Every field below is the only one of its name a recipe may have; any other field is
refused (`RECIPE_INVALID`, or the code of the rule it would break).

| Field | Required | What it holds |
| --- | --- | --- |
| `id` | yes | The harness's id: lowercase letters, digits and `-`, starting with a letter, at most 40 characters. Not an id the server's harness table already has (`pi`, `claude-agent`, `codex`, `opencode`, `goose`, `cursor`) nor a name its runs carry (`learning`, `sdk`, `workflow`, `claude-agent-sdk`, `codex-sdk`). |
| `label` | yes | The harness's name in a sentence, 1 to 80 characters. |
| `release` | yes | Where the binary comes from: `{ "registry": ID, "version": VERSION, "archives": { PLATFORM: ARCHIVE } }`. `registry` is the agent's id in the ACP registry, `version` its version there. |
| `release.archives.PLATFORM` | at least one | `PLATFORM` as the registry names it: `linux-x86_64`, `linux-aarch64`, `darwin-aarch64`, `darwin-x86_64`. `ARCHIVE` is `{ "url", "format", "sha256", "cmd", "binarySha256"? }`: `url` the registry's `archive` (https), `format` `"tar.bz2"` or `"tar.gz"` (the formats the installer unpacks), `sha256` the registry's `sha256` of the archive (64 lowercase hex digits; when the registry lists none, the sha256 of the archive you downloaded and checked yourself), `cmd` the registry's `cmd` (the binary's path inside the archive, `./agent`). `binarySha256`, when you know it, is the sha256 of the unpacked binary; leave it out and the first install records it (rule 2). |
| `args` | no | The arguments that start the agent in ACP mode over stdio: the registry's `args` (`["acp"]`). |
| `model` | yes | Who bills the model. `{ "billing": "proxy", "wire": "anthropic-messages", "env": NAME, "hostEnv"?: "ANTHROPIC_HOST" \| "ANTHROPIC_BASE_URL" }`, or `{ "billing": "plan", "maxTurns": N, "maxToolCalls": M, "hosts"?: [HOST, ...] }`. See [Billing](#billing). |
| `keys` | no | The names of keys saved for this harness alone (a vendor's API key the agent reads). A plan-billed agent needs at least one. Never a key the server holds for anything else (rule 1). Each is read by name where the check or the run starts, and handed to the agent under the same name; a start where one is not set is refused before the agent runs (`ACP_KEY_MISSING`). |
| `env` | no | Variables the agent gets, each written out as a literal string: `{ "NAME": "value" }`. The place for an agent's switches (turn off its own tools, its telemetry, its session naming). No key, nothing read from the host (rule 5). |
| `files` | no | Files written into the session's private HOME before the agent starts: `{ "path/in/home": "content" }`. A path is relative to HOME (`.config/agent/config.yaml`, or `$HOME/.config/...`). |
| `state` | no | Folders in the private HOME where the agent keeps its sessions (`.local/share/agent/sessions`). AgentRun copies them into the session's records after each turn, so a session survives a crash and moves to another runner. |
| `declares` | yes | What the agent says it can do at ACP `initialize`: `{ "load": true \| false, "mcp": "http" \| "stdio" }`. `load` is whether it resumes a session with `session/load`; `mcp` is how it takes AgentRun's tools (an MCP server over HTTP, or over stdio). A run is refused (`ACP_CAPABILITY_MISMATCH`) when the agent says otherwise. |
| `quirks` | no | `{ "mcpCall": "match" \| "mint" }`: how an MCP call is tied to the agent's tool call, for an agent that announces its calls late (`mint`). Most agents need none. |
| `description` | no | A sentence about the agent. |

An example, for an agent called Acme that bills through AgentRun's proxy:

```json
{
  "id": "acme",
  "label": "Acme",
  "release": {
    "registry": "acme",
    "version": "2.4.0",
    "archives": {
      "linux-x86_64": {
        "url": "https://github.com/acme/acme/releases/download/v2.4.0/acme-x86_64-unknown-linux-gnu.tar.bz2",
        "format": "tar.bz2",
        "sha256": "<the registry's sha256 of that archive>",
        "cmd": "./acme"
      }
    }
  },
  "args": ["acp"],
  "model": { "billing": "proxy", "wire": "anthropic-messages", "env": "ACME_MODEL" },
  "env": { "ACME_PROVIDER": "anthropic", "ACME_TELEMETRY": "off" },
  "files": { ".config/acme/config.yaml": "tools:\n  shell: false\n  edit: false\n" },
  "state": [".local/share/acme/sessions"],
  "declares": { "load": true, "mcp": "http" }
}
```

### The five rules

The loader holds each recipe to five rules before anything is downloaded or started, and refuses one that breaks a rule
with that rule's code. `agentrun harness install --recipe` and `agentrun harness-check` both load a recipe this way.

1. **Own keys only** (`RECIPE_KEY_NOT_OWN`). `keys` names keys saved for this harness alone. A key the server holds for
   something else is refused: every model provider's (`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`,
   `XAI_API_KEY`, ...), the gateway's (`AGENT_MODEL_*`), the tools' and the computers' keys, and AgentRun's own
   (`AGENTRUN_*`). `env` names no key at all, since a value in a recipe file is plain text: a variable whose name has a
   `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PAT`, `CREDENTIAL` or `DSN` segment is refused there.
2. **A pinned binary** (`RECIPE_BINARY_UNPINNED`). The binary is the release's archive for the platform, as the
   registry lists it: an https URL and its sha256. A recipe names no `command`, `binary` or `path` of its own. The
   binary's sha256 is pinned when the recipe gives `binarySha256`; when it doesn't (some registry entries list only the
   archive's digest, or none), the owner's install records the first one it unpacks from the verified archive, and a
   binary that differs later is refused, at a check and a reinstall alike (`HARNESS_BINARY_MISMATCH`).
3. **Private paths** (`RECIPE_PATH_OUTSIDE`). Every `files` path and `state` folder is inside the session's private
   HOME: no absolute path, no `..`. The archive's `cmd` stays inside the agent's own folder.
4. **The owner installs it** (`RECIPE_INSTALLS_ITSELF`). Only `agentrun harness install --recipe FILE` downloads and
   unpacks the release. A recipe has no `install`, `postinstall`, `setup` or `script` step of its own, and a check of
   an agent that is not installed downloads nothing: it is refused with `HARNESS_NOT_INSTALLED` and the command that
   installs it.
5. **An allowlist environment** (`RECIPE_ENV_NOT_ALLOWLIST`). The agent's process gets `PATH`, `LANG` and `TZ` from the
   host, its private `HOME`, `TMPDIR` and XDG folders, the recipe's `env`, its own `keys`, and the proxy's address and
   key: nothing else. A recipe can't ask for more (`passEnv`, `inheritEnv` and the like are refused), can't set what the
   adapter or the proxy sets (`HOME`, `PATH`, `ANTHROPIC_HOST`, ...), and writes every value out: `$HOME/.cache` in a
   value is refused, since nothing of the host's environment reaches the agent to fill it in.

### Billing

- **`proxy`**: the agent speaks Anthropic's Messages API, and AgentRun's model proxy sits between it and the provider.
  The agent gets the proxy's address in `ANTHROPIC_HOST` (or `ANTHROPIC_BASE_URL`, with `"hostEnv":
  "ANTHROPIC_BASE_URL"`) and a key that only opens the proxy in `ANTHROPIC_API_KEY`; it reads the run's model id from
  the variable `model.env` names. The proxy adds the provider's key, asks the run's cap before each request and books
  what each answer cost. It forwards `POST /v1/messages` alone and answers `GET /v1/models` itself. It refuses a request
  that offers the model a tool that is not AgentRun's: AgentRun's tools reach the agent as one MCP server named
  `agentrun`, and the agent must offer them to its model as `agentrun__<tool>`. Turn the agent's own tools off in its
  config (`files`) or `env`. Today the proxy is the one Goose runs on, so it also lets through Goose's `load_skill` and
  only the `anthropic-beta` values Goose 1.59.2 sends.
- **`plan`**: the agent calls its vendor itself, on the owner's plan and the recipe's own `keys`. AgentRun never sees
  those requests, so the adapter stops the run itself after `maxTurns` turns or `maxToolCalls` tool calls
  (`ACP_TURN_LIMIT`, `ACP_TOOL_CALL_LIMIT`). `hosts` (up to 16, each `host` or `host:port` with a port from 1 to 65535,
  443 by default) names where the vendor's model is: `harness-check` tunnels the agent's `CONNECT` to those hosts and
  refuses the rest, so list every host the agent needs for a turn.

### Install it

```sh
agentrun harness install --recipe acme.json
```

It loads the recipe (the five rules), downloads the archive for this platform, checks its sha256 against the recipe,
unpacks it beside the harness's folder, checks the binary's sha256 (or records the first one), then moves it into
`~/.agentrun/harnesses/<id>` and makes it read-only. `--data DIR` installs into another AgentRun's data directory. No key
reaches the install. Run it again with the binary in place and it downloads nothing.

A failure names its code and the command to try again: `HARNESS_PLATFORM_UNSUPPORTED` (no archive for this platform),
`HARNESS_DOWNLOAD_FAILED`, `HARNESS_ARCHIVE_MISMATCH` (the archive's sha256 is not the recipe's),
`HARNESS_BINARY_MISMATCH` (the binary's is not the pinned or the first recorded one).

### Check it

```sh
OPENROUTER_API_KEY=... agentrun harness-check --recipe acme.json --model openrouter/anthropic/claude-haiku-4.5
```

`harness-check` loads the recipe, finds the binary the install put in place and checks its sha256, then runs the agent
on the model for four short turns, as AgentRun would run it, in a private HOME under the system's temp directory. It
gives the agent two tools of its own over MCP, `check_echo` (allowed) and `check_denied` (refused by the gate).

Stage 2, the real binary:

- `tools_off`: the agent's first model request offers only AgentRun's tools.
- `env_allowlist`: the agent's environment, read from `/proc/<pid>/environ`, holds only the allowlist's names, and no
  value of a key the host holds, under any name (`hostSecretsSeen`).
- `limits`: proxy billing: once the cap is set at what the check has spent, the next request is refused and never
  sent. Plan billing: `maxTurns` and `maxToolCalls` are set.
- `pins`: every start of the agent's process ran the pinned binary.
- `side_requests`: the provider got the turns' Messages requests and nothing else. What the agent reaches for beyond
  loopback goes to the check's own HTTPS proxy, which refuses it and lists it (`beyondLoopbackRefused`). For plan
  billing, a `CONNECT` to one of `model.hosts` is tunneled and listed in `toVendor`; what goes through the tunnel is
  the vendor's and is not read, so this stage is reported, not passed or failed.

Stage 3, live:

- `mcp_tool`: the model calls `check_echo`, it runs once over MCP, and its result reaches the model.
- `resume`: the agent's process is killed (SIGKILL) after turn 1; turn 2 starts a new one, which loads the session
  (`session/load`) or starts a fresh one told the conversation, and the model still knows what `check_echo` returned.
- `denied_call`: the model calls `check_denied`, the gate refuses it, and it never runs.
- `other_runner`: a second runner with its own directory picks the session up from the records.

It writes a JSON report (`--report FILE`, default `./harness-check-<id>.json`) and prints each check and the three facts
a harness row carries:

- `resume`: `load` (the agent reloaded its own session after the kill) or `restart` (a fresh session, told the
  conversation).
- `tool_gate`: `permission` (the agent asks before a tool call, `session/request_permission`) or `config` (it never
  asks, so its tools are gated only by its config).
- `billing`: `proxy` or `plan`.

The report's `gate` says how the tool gate was reached: each permission the agent asked for, and each question the gate
was asked. The adapter ties a call to AgentRun's tools by the title the agent gives it: `agentrun__<tool>`,
`agentrun: <tool>` (Goose 1.59.2 writes the tool's underscores as spaces, `agentrun: check echo`) or
`agentrun-<tool>: <tool>`. A permission it can't tie reaches the gate as the agent's own (`acp_<kind>`) and the check
refuses it, so an untied title fails `mcp_tool`.

`--cap USD` bounds what the check spends (default $0.25). `--data DIR` is the data directory the agent was installed
into. Exit 0 when every check passed, 1 when the recipe was refused, the binary is not installed or pinned, or a check
failed, 2 for a wrong flag.

### What a passing check looks like

```text
stage 2 tools_off: pass
stage 2 env_allowlist: pass
stage 2 limits: pass
stage 2 pins: pass
stage 2 side_requests: pass
stage 3 mcp_tool: pass
stage 3 resume: pass
stage 3 denied_call: pass
stage 3 other_runner: pass
resume: load
tool_gate: permission
billing: proxy
spend: $0.00412
harness-check: passed
report: /work/harness-check-acme.json
```

A refused recipe prints one line, `harness-check: refused: <CODE>: <every problem>`, and runs nothing.

### Limits today

- The installer unpacks `.tar.bz2` and `.tar.gz` archives alone; some registry agents ship `.zip`, or an npm or uv
  package with no archive at all. See [HARNESS-SCORECARD.md](HARNESS-SCORECARD.md).
- Proxy billing takes Anthropic's Messages API as Goose speaks it (tool names, betas). An agent on another wire is
  plan-billed, or needs a harness module.
- The environment check reads `/proc` (Linux). Side requests beyond loopback are seen for an agent that honors
  `HTTPS_PROXY`.
