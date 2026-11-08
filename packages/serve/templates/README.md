# Template packages

A template package is one folder that makes a working agent: its manifest, its instructions, its skills, its rules and
its evals. The server ships the packages in this folder, checks each one whole at its start (a broken one stops the
start), lists them at `GET /v2/templates` and applies one with `POST /v2/templates/{name}/apply`. Nothing in a package
runs at apply: it is read, checked, and made into the same agent and trigger records `POST /v2/agents` and
`POST /v2/triggers` make. `agentrun template validate DIR` runs the server's own check on a folder.

```
code-review/
  agent.md                 front matter = the whole manifest; body = the agent's instructions
  skills/<name>/SKILL.md   Agent Skills: front matter names the skill (= its folder) and describes it
  rules/*.md               rules each skill reads: apply puts a copy beside each SKILL.md
  evals/<case>/prompt.md   a case's run input (front matter: description, runs, max_cost_usd, ...)
  evals/<case>/graders/*.md   front matter `type`: llm, regex, tool_used, file_exists or schema (with `schema: <file>`)
  evals/<case>/case.yaml, evals/<case>/fixtures/   optional
  findings.schema.json     any other file the manifest names
```

Links and other special files are refused anywhere in the folder, and its only folders are `skills/`, `rules/` and
`evals/`. Evals are checked for their layout only: no eval runs here.

## The packages this server ships

None needs a sandbox: each reads and writes through web tools and MCP servers the owner saves.

**Writes ask.** Every package reads content someone else wrote (web pages, pull requests, form submissions). So no
package puts a write or a send in its `allow`: each asks until the owner grants it at apply (`grants`), and then it is
the owner's choice, made on the screen that lists it. A package's `allow` holds only the reads its unattended runs
need. A test classifies every MCP tool a shipped package lists as a read or a write, and refuses a write at `allow`.
A pin bounds a write even once granted: `code-review`'s `pull_request_review_write` may only be called with `method`
one of `create`, `submit_pending` or `delete_pending` and `event` left out or `COMMENT`, so a pull request's text can
never get it to approve, request changes or resolve a thread.

**A pinned send goes only where the owner set.** A package may pin a send's destination to a parameter (`pin` in its
`mcp` entry): apply writes it into the agent's tool settings, and the server's tool gate refuses any call of that tool
whose destination is not the pinned one, before it is sent or asked about, even once the owner granted the tool. So
a page that talks the agent into posting elsewhere gets a refusal, never a post. A pin fixes where a send goes, not
what it says, and it does not reach a write to a record (a CRM contact): that one is held by its skill's own check.
`market-monitor` pins `slack_send_message`'s `channel_id` and `GMAIL_SEND_EMAIL`'s `recipient_email` to its `channel`
parameter (and keeps `cc`, `bcc` and `extra_recipients` out), and `inbound-lead` pins `slack_send_message`'s
`channel_id` to its `slack_channel`. `market-monitor`'s `channel` takes a Slack channel id or an email address: each
pin applies only to its own tool, so a channel id leaves no address `GMAIL_SEND_EMAIL` can send to and an address no
channel Slack can post in, and its skill sends with the tool that matches the destination's kind. A send whose
destination parameter apply was not given is set to deny, so it never runs. Until the agent store's cutover an agent
keeps no pin of its own: apply says so (`pins.<tool>`), with the pin to set on the server meanwhile, and the sends ask
unless granted.

**Scope the credentials.** An allowed read reaches whatever the saved credential reaches. Save `github` with a
fine-grained token for the one repository the agent works on, `hubspot` with the scopes its tools need, and so on: once
the owner grants a write, text the agent read could try to copy what that read reaches into it.

| Package | What it does | Started by | Needs |
|---|---|---|---|
| `code-review` | Reviews a pull request for real bugs and posts one comment review | a run naming a PR, or a GitHub webhook trigger the owner adds | the GitHub MCP server `github` to read and post; with none, a diff in the message |
| `kyb` | Business due diligence: identity, owners, sanctions against the lists themselves, adverse media, a verdict, every claim cited | a run naming a company | nothing; web tools only |
| `market-monitor` | A weekly digest of what changed at the companies you watch, posted to one Slack channel or address | a weekly schedule (its `cron` and `timezone` parameters, Monday 08:00 UTC by default), or a run | optional: Slack (`slack`) or Gmail (`gmail`) MCP, to send |
| `inbound-lead` | Researches a form or CRM lead, scores it against your ICP, writes back to HubSpot or posts to Slack | a webhook (needs the seal key), or a run | optional: HubSpot (`hubspot`) or Slack (`slack`) MCP |
| `release-notes` | Turns the merged PRs since the last release into user-facing notes, as a draft issue to edit (no MCP tool makes a draft release) | a run naming the release or tag | the GitHub MCP server `github`; with none, a list of PRs in the message |

## Eval cases

Each `evals/<case>/` is one test of the package's agent. No eval runs on the server; a runner reads this layout.

- `prompt.md`: its body is the run's input, written as the agent receives it (a webhook case as the trigger delivers
  it: the trigger's words, then the body in `<trigger-payload ... untrusted>`). Front matter: `description`, `runs`
  (how many times; the case passes when every run passes), `max_cost_usd` (each run's cap).
- `case.yaml`, optional: `parameters` (the apply's parameters), `grants` (the gate names the apply allows, always a
  list), `mcp` (a server's name to a fixture file in the case that fakes it), `learning` (a folder of notes in the case
  the agent starts with: `MEMORY.md` and its notes).
- A fake MCP server's fixture, one shape for every package:
  ```json
  { "server": "github", "description": "what the fake holds",
    "tools": { "get_file_contents": { "description": "...", "input": { "type": "object" },
      "answers": [ { "when": { "path": "README.md" }, "result": { "content": [ { "type": "text", "text": "..." } ] } } ],
      "default": { "content": [ { "type": "text", "text": "not found" } ], "isError": true } } } }
  ```
  An answer is taken when every argument its `when` lists equals the call's, the first that does; else `default`. Each
  `result` is an MCP tool result.
- `fixtures/`: what the case's fakes and notes read.
- `graders/*.md`, each one check of every run, by its front matter's `type`:
  - `llm`: the body is the rubric a blind grader applies to the answer (or to `target`, one field of the answer's JSON).
  - `regex`: `pattern` over the answer (or `target`), with `flags` and `expect: match` (the default) or `no_match`.
  - `tool_used`: `tool` (or `tools`, a list), `expect: called` (the default) or `not_called`, and optionally `count` and
    `args` (the arguments a call must carry).
  - `file_exists`: `path` in the run's work folder.
  - `schema`: `schema`, a JSON Schema file in the package, which the answer's last fenced `json` block meets.

## agent.md

| Field | |
|---|---|
| `name` | Required. The folder's name: lowercase letters, digits and dashes, at most 64. |
| `display_name` | The agent's name; it may hold `${parameters.<name>}`. Absent: the package's name. |
| `version` | Required. SemVer 2 (`0.1.0`), the package's own version. Never `definition.version`, which is the agent's revision number; a bare number is refused. |
| `description` | Required. Also the agent's description. |
| `license`, `author` (`{name, email?, url?}`), `repository` | Optional, shown in the list. |
| `harness` | A preference list (`[pi, claude-agent]`): apply takes the first this server runs, else the first. Absent: the server's default. |
| `model` | `{tier: fast \| balanced \| strong, prefer?: "provider/model-id"}`. Apply uses `prefer` when this server runs it on the chosen harness (it has the provider's key, or a gateway); otherwise the server's model for the tier: `AGENT_MODEL_FAST`, `AGENT_MODEL` (balanced) or `AGENT_MODEL_STRONG`, each else the default of a model key the server holds. `overrides.model` in the apply wins over both. Absent: the server's default. |
| `effort` | The thinking level: `low`, `medium`, `high`, `xhigh` or `max`. |
| `tools` | The tools the agent is granted, never an MCP tool (`mcp` grants those). Absent: those the server gives a new agent (its box's shell, where it has a box). |
| `mcp` | `[{server, tools, required?, allow?, pin?}]`: MCP servers by the name a server saves them under (Settings → MCP servers), the tools of each the agent uses (each one tool by its name, `A-Z a-z 0-9 _ . -`; never `*`), and `allow`, those of its tools the package asks the owner to allow (`GET /v2/templates` shows each tool with `asks: allow` or `ask`, for a consent screen). Where the server has one saved, apply grants `mcp:<server>/<tool>` for each, beside the other tools, at the owner's own setting: a package never sets a permission. Only the apply's `grants`, the owner's answer, are set to `allow`. Where it has none, apply skips it with a warning (`mcp.<server>`), or, when `required` is true, refuses with `409 agent_not_runnable` and makes nothing. `pin`, optional: `{<tool>: {<argument>: <value>}}`, for tools of the entry, 1 to 8 top-level arguments each, every value a scalar (text, which may be or hold `${parameters.<name>}`, a number, `true`/`false`, or `null` for an argument that must be left out) or a list of 1 to 16 of them, the argument one of the list (`event: [null, COMMENT]`), in the order written. Apply writes it, filled, as the tool's `pin` in the agent's `tool_settings` (text that is one placeholder alone takes the parameter's value and type), whatever the tool's permission, and the gate refuses any call not as pinned. Until the agent store's cutover an agent keeps no pin of its own: apply writes none, and warns `pins.mcp:<server>/<tool>` with the pin, filled, to set on the server (Settings → Tools), which holds every agent's calls of the tool; the send asks unless granted. A pin whose parameter apply is not given sets the tool to `deny` instead, granted or not, with a `pins.mcp:<server>/<tool>` warning. `GET /v2/templates` shows each tool's `pin`, unfilled. |
| `computer` | `default` only, for now: the agent runs where this server puts a new one. |
| `parameters` | By name: `{type: string \| number \| integer \| boolean, required?, pattern? (strings), default?, description}`. Apply takes them in `parameters`, and one left out takes its `default`. `display_name`, the body, a trigger's `target.input`, a schedule's `cron` and `timezone` and an `mcp` entry's `pin` values name them as `${parameters.<name>}`, nowhere else. A parameter a schedule uses has a default, and the package's own schedule is checked with it; apply checks every trigger with the parameters given before it makes anything, so a bad cron or zone is a `422` under `triggers.<i>`. |
| `secrets` | Variable names (never values) the server must hold: a model or tool key Settings saves (`OPENROUTER_API_KEY`, `PARALLEL_API_KEY`, ...), set where it starts or saved there. Any other name is refused: the server could neither save it nor hand it to a run. Apply refuses with `409 agent_not_runnable`, making nothing, when one is missing. |
| `budget` | `{per_run_usd}`: each run's cap (the agent's `max_cost_usd`). Required when the package has triggers. |
| `learning` | `true` or `false`: whether the agent's runs learn. |
| `triggers` | `POST /v2/triggers` bodies with no `agent_id` (the target is a `start_run`), each with a `name`, unique in the package: the key an upgrade will match triggers by. |
| `output` | `{schema: <file>}`: the JSON Schema of the agent's answer, a file in the package. |
| `checks` | Names of structural checks of a run's answer; none runs yet. |

The check is whole: the package is compiled with a sample of each parameter, and the agent body and each trigger body are
checked as `POST /v2/agents` and `POST /v2/triggers` check theirs (all but the agent a trigger names, which apply makes).
A tool the server does not bind, a trigger field or schedule it refuses, or a skill file's path is refused here, not at
apply. A trigger's date is checked for its form only: one that has passed is refused at apply, never at a server's start. A package holds at most 256 files, each at most 256 KiB, and 1 MiB together (`POST /v2/agents`' own body limit).

## Apply

`POST /v2/templates/{name}/apply` with `{parameters, grants?, overrides?: {model}}`:

1. The parameters and `grants` are checked against the package (`422` naming each field: a grant is one of the
   package's MCP tools by its gate name, `mcp:<server>/<tool>`), then its secrets, its required MCP servers and, for a
   webhook trigger, the server's seal key (`409`), then every trigger as `POST /v2/triggers` checks it, its parameters
   filled (`422` under `triggers.<i>`). Nothing is made yet.
2. The agent is made through `POST /v2/agents`' own function: named by `display_name` (else the package's name),
   described as the package, its MCP tools granted where their server is saved, each at the owner's setting (a
   third-party tool asks by default) and those in `grants` set to `allow`, never one the owner denies on this server
   (it stays denied, with a `grants.<tool>` warning), each pinned tool with its pin filled (or set to `deny`, with a
   `pins.<tool>` warning, when its parameter was not given), its body held to `POST /v2/agents`' 1 MiB limit (`413`), its instructions
   the body with the parameters filled in, its skills and rules as its skill files, its harness and model chosen as
   above, `thinking` from `effort`, `max_cost_usd` from `budget`.
3. Each trigger is made on the agent through `POST /v2/triggers`' own function. One that still fails (the store, say)
   undoes the apply: the triggers made before it are deleted and the agent is archived, and the failure is the answer.
   A webhook trigger's secret is not in the answer: `POST /v2/triggers/{id}/secret` makes one.

Each apply makes a new agent. The same `Idempotency-Key` and body answers the first apply again and makes nothing.

A grant is written as the agent's own tool setting (`definition.tool_settings`), and an agent's setting outranks the
server's, as it does for any agent: a server-wide deny the owner sets after the apply does not reach that agent. To take
a grant back, edit the agent's `tool_settings`.
