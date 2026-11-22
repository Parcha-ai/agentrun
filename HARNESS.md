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
   It is done when it ends as [What passing looks like](#what-passing-looks-like) shows.
2. Copy the example from the tag of the release your server runs,
   `https://github.com/Parcha-ai/agentrun/tree/v<version>/examples/harness-module`, to a folder of your own, and give
   it your package name. Its `@parcha` pins are that release's. Change [what you write](#what-you-write): the id, the
   facts, the recipe, the proxy and `missing`.
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

A new id that matches `^[a-z][a-z0-9-]{0,39}$`. A module can't take an id a recipe can't: a built-in harness's, or
a name serve reserves (both listed in the recipe's [`id` row](#field-by-field)). If it does, the server refuses to
start and names the module and the id.

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

Its offer promises each tool call through the agent's permission ask and billing through the proxy. `resume` defaults
to `"restart"`; `"load"` needs the recipe's `declares.load`, else its first launch is refused (`HARNESS_RESUME_UNDECLARED`).

Any other agent runs on an adapter you write (the kernel's `AgentAdapter`). Give `kit.adapterEntry(facts, adapter)`,
where `adapter(launch)` builds it for one run. `launch` holds the model, where to forward its requests
(`launch.provider`: the origin, the credential and how it is sent), the price of a request's usage, a log, the
confinement its process starts under, the skills it loads itself (`launch.skills`), and the server's environment. Your
harness gets `launch.skills` only when it loads skills itself: give `kit.adapterEntry` a `skillCheck` in its third
argument, and the run's skills that check accepts are taken out of the prompt and handed to your adapter.
`kit.acpEntry` has no `skillCheck`, because the ACP adapter loads no skills, so an ACP agent's skills stay in its prompt.

A module may instead give a whole entry with its own runner (the members [serve's README](packages/serve/README.md#harness-modules)
lists): it then states by hand what the kit derives from the facts (models, key rows, offer, refusal and price), and
without facts its agent gets pi's tools, not the host tools.

For either one, serve picks the model and the key the way it does for its own harnesses. A person's Claude Code login is
never a module's credential. An entry's `ownKeys` names no key a built-in harness owns (Cursor's `CURSOR_API_KEY`): if
it does, the server refuses to start with `HARNESS_KEY_OWNED` and names the module, the id and the key.

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

The subject runs your adapter in that loop, its run's spec naming your facts (`facts`), as the loop reads them on a
server. Its cases crash the run at each point that matters and check what happens:
before a tool's intent is recorded and after it, mid-answer, with the runner process killed, and with a run paused past
its lease. A tool that changes something must run at most once; a resumed run must pick up where it was. Your facts
say which cases your harness rules out, and the suite skips each of those with the reason.

An ACP agent's module runs the suite on `@parcha/agentrun-harness-acp/testing`. `fakeAgentRecipe(id, dir, script)`
starts a fake ACP agent whose model is the suite's script. It needs no binary, no model and no key, so the suite runs
before any real agent is in it. `examples/harness-module/test/subject.mjs` is the whole subject. Keep it in a module of
its own: the suite's process cases start a second runner process that imports it.

Import `@parcha/agentrun-serve/conformance` from test files only: its runner has test hooks and must never load in a
server.

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
`promises`, and either `available: true` and the `keys` that run it, or `available: false` and the `reason`.

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
lists with a binary release packed as `.tar.bz2`, `.tar.gz` or `.zip`. A recipe is installed, signed in where its
agent signs a person in, checked, and then run by a server that names it ([Run it](#run-it)). A whole one, for Google Antigravity
(a `.zip`, a key handed under the name the agent reads, and a person's own sign-in), is in
[examples/harness-recipe](examples/harness-recipe/README.md).

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
| `id` | yes | The harness's id: lowercase letters, digits and `-`, starting with a letter, at most 40 characters. Not an id the server's harness table already has (`pi`, `claude-agent`, `codex`, `opencode`, `goose`, `cursor`) nor a name serve reserves: one its own runs carry (`learning`, `sdk`, `cli`, `codex-cli`, `claude-code-cli`, `workflow`, `claude-agent-sdk`, `codex-sdk`, `eve`, `external`) or every object has (`constructor`). |
| `label` | yes | The harness's name in a sentence, 1 to 80 characters. |
| `release` | yes | Where the binary comes from: `{ "registry"?: ID, "version": VERSION, "archives": { PLATFORM: ARCHIVE } }`. `registry` is the agent's id in the ACP registry, when it comes from there; `version` its version there, or the vendor's own release's. |
| `release.archives.PLATFORM` | at least one | `PLATFORM` as the registry names it: `linux-x86_64`, `linux-aarch64`, `darwin-aarch64`, `darwin-x86_64`. `ARCHIVE` is `{ "url", "format", "sha256" \| "sha512", "cmd", "binarySha256"?, "treeSha256"?, "args"? }`: `url` the registry's `archive` (https), `format` `"tar.bz2"`, `"tar.gz"` or `"zip"` (the formats the installer unpacks), and one digest of the archive: `sha256` the registry's `sha256` (64 lowercase hex digits; when the registry lists none, the sha256 of the archive you downloaded and checked yourself), or `sha512` (128) where the vendor's own manifest lists that, as Google's agy CLI manifests do. `cmd` the registry's `cmd` (the binary's path inside the archive, `./agent`). `binarySha256`, when you know it, is the sha256 of the unpacked binary, and `treeSha256` the digest of every file the archive unpacks to; leave either out and the first install records it (rule 2). `args`, when the registry lists them for this platform alone (Antigravity's linux `["--uid="]`), start the agent on this platform in place of the top-level `args`. |
| `args` | no | The arguments that start the agent in ACP mode over stdio: the registry's `args` (`["acp"]`), on every platform whose archive names none of its own. |
| `model` | yes | Who bills the model. `{ "billing": "proxy", "wire": "anthropic-messages", "env": NAME, "hostEnv"?: "ANTHROPIC_HOST" \| "ANTHROPIC_BASE_URL" }`, or `{ "billing": "plan", "maxTurns": N, "maxToolCalls": M, "hosts"?: [HOST, ...], "id"?: MODEL }`. See [Billing](#billing). |
| `keys` | no | The keys saved for this harness alone (a vendor's API key the agent reads). A plan-billed agent needs at least one, or a `signIn`. Never a key the server holds for anything else, and every saved name named as a key (rule 1). Each entry is a name, handed to the agent under that same name, or `{ "name": SAVED, "env": NAME }`, handed as `NAME`: a Gemini agent's key saved as `ANTIGRAVITY_GEMINI_API_KEY` reaches it as `GEMINI_API_KEY`, while the server's own `GEMINI_API_KEY` never does. Each is read by its saved name where the check or the run starts; a start where one is not set is refused before the agent runs (`ACP_KEY_MISSING`). |
| `keyMethod` | no | The sign-in method the agent's ACP `initialize` lists for its key (Antigravity's `gemini-api-key`): the adapter sends `authenticate` with it before any session opens. Needs `keys`. See [Sign-in](#sign-in). |
| `signIn` | no | The owner's own sign-in, made by the agent's own command: `{ "args": [ARG, ...], "homeArg": FLAG }`, `args` the agent's sign-in flags (agy's `["--login"]`) and `homeArg` the flag that names the folder it keeps that sign-in in (agy's `--gemini-dir`). Plan billing alone. See [Sign-in](#sign-in) and [Vendor terms](#vendor-terms). |
| `env` | no | Variables the agent gets, each written out as a literal string: `{ "NAME": "value" }`. The place for an agent's switches (turn off its own tools, its telemetry, its session naming). No key, nothing read from the host (rule 5). |
| `files` | no | Files written into the session's private HOME before the agent starts: `{ "path/in/home": "content" }`. A path is relative to HOME (`.config/agent/config.yaml`, or `$HOME/.config/...`). |
| `state` | no | Folders in the private HOME where the agent keeps its sessions (`.local/share/agent/sessions`). AgentRun copies them into the session's records after each turn, so a session survives a crash and moves to another runner. It keeps only the bytes that changed since the last copy, never SQLite's `-shm` file, and at most 8 MiB per session. Past that, the run says so and a resume starts the agent fresh with the conversation so far. |
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
   (`AGENTRUN_*`). A key saved under a name of the harness's own may be handed under a provider's name the agent reads
   (`{ "name": "ANTIGRAVITY_GEMINI_API_KEY", "env": "GEMINI_API_KEY" }`): its value is the harness's, read by its
   saved name, never the server's. It is never handed as what the adapter, the proxy or the server sets (`AGENTRUN_*`,
   `AGENT_MODEL_*`), nor as a variable that changes what the agent's process loads or runs (rule 5, refused with
   `RECIPE_ENV_NOT_ALLOWLIST`). A saved key is named once in `keys`, and reaches the agent under one name; two keys are
   never handed under one name. `env` names no key at all, since a value in a recipe
   file is plain text: a variable whose name has a `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PAT`, `CREDENTIAL` or `DSN`
   segment is refused there. The other way round, every name in `keys` (the saved name) has one of those segments
   (`FOO_CRED` is refused; `FOO_CRED_KEY` is not): every child process of the server has its environment cut of names
   shaped as keys, so a harness's own key never reaches a run's tools by its name.
2. **A pinned binary** (`RECIPE_BINARY_UNPINNED`). The binary is the release's archive for the platform, as the
   registry lists it: an https URL and its sha256. A recipe names no `command`, `binary` or `path` of its own. The
   binary's sha256 is pinned when the recipe gives `binarySha256`; when it doesn't (some registry entries list only the
   archive's digest, or none), the owner's install records the first one it unpacks from the verified archive, and a
   binary that differs later is refused, at a check and a reinstall alike (`HARNESS_BINARY_MISMATCH`). The rest of the
   archive is pinned the same way: an archive with more than one executable (Antigravity's ships a sidecar,
   `localharness_external`, beside its server) has its whole tree's digest pinned by `treeSha256` or recorded at the
   first install, so no file beside the binary runs unpinned. A check or a sign-in refuses a tree that changed since.
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
   value is refused, since nothing of the host's environment reaches the agent to fill it in. Nor does it name a
   variable that changes what the agent's process loads or runs before the pinned binary's own code: `PATH`, `LD_*`,
   `DYLD_*`, `NODE_OPTIONS`, `NODE_PATH`, `PYTHON*`, `BASH_*`, `ENV`, `GIT_*`, and a few shells' and interpreters'
   start-up variables (`IFS`, `PS4`, `ZDOTDIR`, `PERL5OPT`, `RUBYOPT`, `JAVA_TOOL_OPTIONS`, ...). That one list, the
   kernel's `launchEnv`, holds for `env`, a key's handed name and `model.env` alike, in the loader
   and in the ACP adapter. A variable's name is a letter or `_`, then letters, digits and `_`, at most 128 characters.
   A key's names, the one it is saved under and the one it is handed as, are stricter: a capital letter, then capitals,
   digits and `_`, at most 64 characters (the kernel's `KEY_NAME`, which the loader and the ACP adapter both read).

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
- **`plan`**: the agent calls its vendor itself, on the owner's plan and the recipe's own `keys` (or the owner's own
  sign-in, see [Sign-in](#sign-in)). AgentRun never sees those requests, so the adapter stops the run itself
  after `maxTurns` turns or `maxToolCalls` tool calls (`ACP_TURN_LIMIT`, `ACP_TOOL_CALL_LIMIT`). `hosts` (up to 16,
  each `host` or `host:port` with a port from 1 to 65535, 443 by default) names where the vendor's model is:
  `harness-check` tunnels the agent's `CONNECT` to those hosts and refuses the rest, so list every host the agent needs
  for a turn. To find them, check once with no `hosts`: the report's `side_requests.beyondLoopbackRefused` lists every
  host the agent reached for, also when its `authenticate` or `session/new` failed for want of one (the check fails,
  and its report still holds the list). `id` names the model the agent runs on, as its `session/new` lists it in
  `availableModels`; the adapter picks it with `session/set_model` before the first prompt, and a model the agent does
  not list is refused before any prompt (`ACP_MODEL_UNLISTED`). Leave it out and the agent runs on its own default.
  An agent on a person's plan lists that plan's models alone: Antigravity on a Google AI plan lists its Gemini models.

### Install it

```sh
agentrun harness install --recipe acme.json
```

It loads the recipe (the five rules), downloads the archive for this platform, checks its sha256 (or sha512) against the recipe,
unpacks it beside the harness's folder, checks the binary's sha256 and the whole tree's (or records the first ones),
then moves it into `~/.agentrun/harnesses/<id>` and makes it read-only. `--data DIR` installs into another AgentRun's
data directory. No key reaches the install. Run it again with the binary in place and it downloads nothing.

A `.zip` unpacks in Node, with no `unzip` on the host: a zip with an entry that leaves the folder (`..`, an absolute
path, a backslash), a symbolic link, a device, an encrypted entry or a duplicate is refused whole, before anything
lands (`HARNESS_UNPACK_FAILED`). A `.tar.bz2` or `.tar.gz` goes to the host's `tar`, into a fresh folder of its own,
with the archive's owners and permissions dropped; AgentRun makes none of the zip's checks on it, so what lands is what
the host's `tar` extracts (symbolic links included). Either way the archive is the one the recipe pins by its digest,
and every file it unpacks to is pinned by the tree's digest (rule 2).

A digest the recipe leaves out is recorded at the first install, one file each under
`~/.agentrun/harnesses/.first-seen/`: `<id>@<version>-<platform>.sha256` for the binary and `.tree.sha256` for the
tree. A record is written once and never over another; to take a new release, change `version` in the recipe. A
release whose binary or tree differs from its record is refused at every check, sign-in and reinstall.

A failure names its code and the command to try again: `HARNESS_PLATFORM_UNSUPPORTED` (no archive for this platform),
`HARNESS_DOWNLOAD_FAILED`, `HARNESS_ARCHIVE_MISMATCH` (the archive's sha256 or sha512 is not the recipe's),
`HARNESS_UNPACK_FAILED` (an unsafe or unreadable archive), `HARNESS_BINARY_MISMATCH` (the binary's or the tree's sha256
is not the pinned or the first recorded one), `HARNESS_INSTALL_BUSY` (another install into the same data directory is running).

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

The report's `gate` lists each permission the agent asked for and each question the gate was asked. A call whose title
the adapter can't tie to an AgentRun tool is refused, and fails `mcp_tool`.

`--cap USD` bounds what the check spends (default $0.25). `--data DIR` is the data directory the agent was installed
into. A check that passes writes `~/.agentrun/harnesses/<id>.checked` there, open to you alone: the sha256 of the
recipe file, of the binary and of its tree, the version and the platform, the pass a server needs ([Run it](#run-it)).
A check that fails writes none. Exit 0 when every check passed, 1 when the recipe was refused, the binary is not installed or pinned, or a check
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

### Sign-in

A plan-billed agent gets into its vendor one of two ways, and a recipe may name both.

**On a key** (`keys`, `keyMethod`). The key is handed to the agent as rule 1 says. When the agent also needs to be
told which method to use, `keyMethod` names it: after ACP `initialize`, the adapter checks the agent lists that method
in `authMethods` (`ACP_AUTH_UNLISTED` when it doesn't) and sends `authenticate` with it before any session opens
(`ACP_AUTH_FAILED` when the agent refuses). Where every key is set, the agent runs this way.

**On its owner's own sign-in** (`signIn`), the way [T3 Code](https://github.com/pingdotgg/t3code) runs Google's agy
CLI: the owner signs the agent in once with the agent's own command, on their own install, and the agent keeps its
sign-in in a folder of its own. `{ "args": [ARG, ...], "homeArg": FLAG }`: `args` the agent's own sign-in flags (agy's
`["--login"]`), and `homeArg` the long flag that names that folder (agy's `--gemini-dir`), its value the next argument.
Plan billing only. `homeArg` appears nowhere else in the recipe's arguments, and no argument holds a `$`.

```sh
agentrun harness sign-in --recipe antigravity.json
```

It checks the installed binary and tree against their pins (nothing is downloaded; `HARNESS_NOT_INSTALLED` with the
install command when they are not in place) and makes the sign-in folder, `~/.agentrun/harnesses/<id>.sign-in`, open to
you alone. It then starts the unmodified agent on your terminal's own stdin, stdout and stderr, with its arguments,
then `signIn.args`, then `homeArg` and the folder (for agy, `agy acp --disable-telemetry --login --gemini-dir DIR`);
HOME and TMPDIR point at a scratch folder removed afterwards, plus the recipe's `env` and `PATH`, `LANG` and `TZ`. No
key reaches it. The agent does the rest: agy prints a Google address to open in any browser, and you paste the code it
shows back into the terminal. You have 10 minutes. When the agent exits 0, AgentRun writes a note beside the folder,
`<id>.signed-in` (the time and the version, nothing of the agent's), and nothing else.

Once signed in, `harness-check` uses the sign-in where the recipe's keys are not set, and a server's runs always do
([Run it](#run-it)): the agent starts with `homeArg` and the folder added to its arguments, no key, no `keyMethod`,
and the ACP adapter's `stderr: "none"`, so nothing it prints or answers is kept. A recipe with a `signIn` whose keys
are not set and that is not signed in is refused with `HARNESS_NOT_SIGNED_IN`, which names both the keys and the
sign-in command.

**The hard rule: AgentRun never reads, refreshes or sends the token, and has no usage reader.** The agent signs itself
in, keeps its sign-in in its own folder, refreshes it and sends it to Google itself. AgentRun hands it the folder's path
and nothing else: it never lists, opens, copies or moves what is in the folder, reads none of what the agent prints,
and has no code that calls Google's account, token or quota endpoints (T3 Code's usage reader does; AgentRun does not
copy it). A test holds the harness sources to that. One server has one owner, whose sign-in it is: never share the
sign-in, the folder or the server's runs on it with anyone else, and never copy the folder to another machine.

On macOS the agent may keep its sign-in in the keychain itself, whatever `AGY_ACP_FORCE_FILE_STORAGE` says (T3 Code
works around that; AgentRun does not). The sign-in is then the agent's, in your keychain, and AgentRun still never
reads it. To sign out, use the agent's own sign-out, or remove the folder and the note.

A failure says AgentRun's own code and, when the agent ended, its exit status, never its words: `HARNESS_NO_SIGN_IN` (the
recipe names no `signIn`), `HARNESS_SIGN_IN_FAILED` (the agent could not start, exited with a status other than 0 or a
signal, or 10 minutes ran out).

### Run it

A server runs a recipe's harness only when it is named, never because it is installed:

```sh
agentrun-serve --data <data> --harness-recipe antigravity.json
```

`--harness-recipe` can be repeated, and `AGENTRUN_SERVE_HARNESS_RECIPES=a.json,b.json` does the same. A separate
`agentrun-serve runner` takes the same flag and needs it to run the harness (its `--check` fails without it). Its runs
run as the server's own user: the install, the check's note and the sign-in are that user's alone, so on a runner that
runs each run as a user of its own (the image's default) a run is refused at its claim until `AGENTRUN_RUN_USER=same`
is set there. A recipe the loader refuses, one with no
archive for this platform, or one whose id a harness module or another recipe already has refuses the start.

The harness is in the server's table from the start, so a run naming it is refused in words, but `GET /v2/capabilities`
lists it as available only once all of these hold, and a run starts only then:

- the binary and its tree are installed and pinned on `<data>` (else `HARNESS_NOT_INSTALLED`, with the install command);
- a `harness-check` passed on `<data>` for this recipe file, this binary and this tree: the `.checked` note's three
  sha256s match (else `HARNESS_NOT_CHECKED`, with the check command). Any edit to the recipe file, or a new binary,
  needs a new check;
- it has a route ([Sign-in](#sign-in)). A proxy-billed agent runs on this server's model proxy. A plan-billed agent runs
  on its owner's sign-in alone (else `HARNESS_NOT_SIGNED_IN`, with the sign-in command). A plan-billed recipe with only
  `keys` is refused with `HARNESS_KEYS_UNSUPPORTED`: a recipe's keys reach no run on a server yet.

Each start of the agent's process digests the binary and its tree again and refuses a start where either differs from
its pin. A run's agent reaches beyond loopback through the server's own egress proxy, as on the check: a `CONNECT` to
one of a plan-billed recipe's `model.hosts` is tunneled, and everything else is refused.

### Vendor terms

A person's sign-in is the vendor's to allow. Read your vendor's terms yourself: this section is not legal advice, and a
vendor's terms change. The words below are quoted as they stood in November 2026.

**Google Antigravity.** The [Google Antigravity Additional Terms of Service](https://antigravity.google/terms),
section 6:

> You must not abuse, harm, interfere with, or disrupt the Service. This includes, but is not limited to, using the
> Service in connection with products not provided by us. Using third party software, tools, or services to access the
> Service (e.g. using OpenClaw with Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for
> suspension or termination of your Antigravity and/or Gemini CLI accounts.

Google's [ACP page](https://antigravity.google/docs/ide/extensions/acp/):

> Any ACP client can launch Antigravity CLI. Configure it to run this command with the project directory as the
> working directory: agy acp

> Sign in once with an interactive agy session, or run agy acp --login . agy acp reuses the cached credentials.

> If no credentials are available, requests fail with the error Authentication required (code -32000 ), and the client
> can ask you to sign in with one of these methods

| Method ID | Notes |
| --- | --- |
| `oauth-personal` | Opens a browser sign-in for a personal Google account |
| `gemini-api-key` | Reads GEMINI_API_KEY from the agent’s environment |

AgentRun's recipe is that ACP page's route, as T3 Code takes it: Google's own `agy` binary, pinned by the sha512 its
manifest lists and by its whole tree (rule 2) and never patched, launched as `agy acp`, signed in with its own `agy acp
--login`, by the owner, on their own install. Section 6 is about third-party software accessing the Service with
Antigravity's OAuth; under the hard rule above, AgentRun never touches that OAuth itself, and the agent that does is
Google's. Where you read the terms otherwise, or where several people use the server, run on a Gemini API key from
Google AI Studio saved for the harness alone (`keys`, `keyMethod` `gemini-api-key`).

The built-in Cursor recipe in `packages/run-adapters-acp/recipes/cursor.json` is the ACP adapter's own, not this file's
format, and runs on Cursor's key alone.

### Limits today

- A server runs a plan-billed recipe on its owner's sign-in, not on its `keys` (`HARNESS_KEYS_UNSUPPORTED`): the
  store for a harness's own keys comes next.
- The installer unpacks archives alone; some registry agents ship an npm or uv package with no archive at all. See
  [HARNESS-SCORECARD.md](HARNESS-SCORECARD.md).
- Proxy billing takes Anthropic's Messages API as Goose speaks it (tool names, betas). An agent on another wire is
  plan-billed, or needs a harness module.
- The environment check reads `/proc` (Linux). Side requests beyond loopback are seen for an agent that honors
  `HTTPS_PROXY`.
