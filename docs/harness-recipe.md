# Bring your own harness: a recipe

A harness is the loop that runs an AgentRun agent. AgentRun ships pi, Claude Code, Codex, OpenCode and Goose. There are
two ways to bring another one:

- **A recipe** (this page): a JSON file that says how to run an [Agent Client Protocol](https://agentclientprotocol.com)
  agent AgentRun does not ship. You write no code. Its owner installs the agent's release with one command, and
  `agentrun harness-check` runs it for real and says whether it keeps AgentRun's rules.
- **A harness module**: a small package with an adapter of its own, for an agent a recipe can't describe. See
  HARNESS.md ([#3198](https://github.com/Parcha-ai/agentrun/pull/3198)), where this page will fold in as its recipe
  section.

A recipe fits an ACP agent that the [ACP registry](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
lists with a binary release packed as `.tar.bz2`. Today a recipe is checked and installed; a server does not yet run one
as a harness of its own. A recipe that passes `harness-check` is what that server-side step will take.

## What you need

- AgentRun's CLI and server, with the ACP adapter beside the server: `@parcha/agentrun`, `@parcha/agentrun-serve` and
  `@parcha/agentrun-harness-acp` installed in the same `node_modules`.
- The agent's entry in the ACP registry: its version and, for your platform, the archive's URL, its sha256 and the
  binary's path inside it.
- For an agent billed through AgentRun's model proxy: a model key in your environment, `OPENROUTER_API_KEY` or
  `ANTHROPIC_API_KEY`. The agent never sees it.
- Linux, for the full check: the agent's environment is read from `/proc`.

## A recipe, field by field

A recipe is one JSON object. Every field below is the only one of its name a recipe may have; any other field is
refused (`RECIPE_INVALID`, or the code of the rule it would break).

| Field | Required | What it holds |
| --- | --- | --- |
| `id` | yes | The harness's id: lowercase letters, digits and `-`, starting with a letter, at most 40 characters. Not one AgentRun already has (`pi`, `claude-agent`, `codex`, `opencode`, `goose`) nor a name its runs carry (`learning`, `sdk`, `workflow`, `claude-agent-sdk`, `codex-sdk`). |
| `label` | yes | The harness's name in a sentence, 1 to 80 characters. |
| `release` | yes | Where the binary comes from: `{ "registry": ID, "version": VERSION, "archives": { PLATFORM: ARCHIVE } }`. `registry` is the agent's id in the ACP registry, `version` its version there. |
| `release.archives.PLATFORM` | at least one | `PLATFORM` as the registry names it: `linux-x86_64`, `linux-aarch64`, `darwin-aarch64`, `darwin-x86_64`. `ARCHIVE` is `{ "url", "format", "sha256", "cmd", "binarySha256"? }`: `url` the registry's `archive` (https), `format` `"tar.bz2"`, `sha256` the registry's `sha256` of the archive (64 lowercase hex digits; when the registry lists none, the sha256 of the archive you downloaded and checked yourself), `cmd` the registry's `cmd` (the binary's path inside the archive, `./agent`). `binarySha256`, when you know it, is the sha256 of the unpacked binary; leave it out and the first install records it (rule 2). |
| `args` | no | The arguments that start the agent in ACP mode over stdio: the registry's `args` (`["acp"]`). |
| `model` | yes | Who bills the model. `{ "billing": "proxy", "wire": "anthropic-messages", "env": NAME, "hostEnv"?: "ANTHROPIC_HOST" \| "ANTHROPIC_BASE_URL" }`, or `{ "billing": "plan", "maxTurns": N, "maxToolCalls": M, "hosts"?: [HOST, ...] }`. See [Billing](#billing). |
| `keys` | no | The names of keys saved for this harness alone (a vendor's API key the agent reads). A plan-billed agent needs at least one. Never a key the server holds for anything else (rule 1). |
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

## The five rules

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
   binary that differs later is refused (`ACP_BINARY_DRIFT` at a check, `HARNESS_BINARY_MISMATCH` at a reinstall).
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

## Billing

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
  (`ACP_TURN_LIMIT`, `ACP_TOOL_CALL_LIMIT`). `hosts` (up to 16, each `host` or `host:port` with a port from 1 to 65535, 443 by default) names
  where the vendor's model is: `harness-check` tunnels the agent's `CONNECT` to those hosts and refuses the rest, so
  list every host the agent needs for a turn.

## Install it

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

## Check it

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
was asked. A permission the adapter can't tie to a call of AgentRun's tools reaches the gate as the agent's own
(`acp_<kind>`, with the agent's title), as Goose 1.59.2's `agentrun: check echo` does; the check answers it by the tool
the title names.

`--cap USD` bounds what the check spends (default $0.25). `--data DIR` is the data directory the agent was installed
into. Exit 0 when every check passed, 1 when the recipe was refused, the binary is not installed or pinned, or a check
failed, 2 for a wrong flag.

## What passing looks like

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

## Limits today

- The installer unpacks `.tar.bz2` archives alone; most registry agents ship `.tar.gz` or `.zip`, or an npm or uv
  package with no archive at all. See [HARNESS-SCORECARD.md](../HARNESS-SCORECARD.md).
- Proxy billing takes Anthropic's Messages API as Goose speaks it (tool names, betas). An agent on another wire is
  plan-billed, or needs a harness module.
- The environment check reads `/proc` (Linux). Side requests beyond loopback are seen for an agent that honors
  `HTTPS_PROXY`.
- A server doesn't run a recipe as a harness yet: `harness-check` is the whole of door 1 for now.
