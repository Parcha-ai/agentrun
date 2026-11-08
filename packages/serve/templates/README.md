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
`evals/`. The server checks evals for their layout only and runs none; `agentrun template eval DIR` runs them ([Running
the evals](#running-the-evals)).

## The packages this server ships

None needs a sandbox: each reads and writes through web tools and MCP servers the owner saves.

**Writes ask.** Every package reads content someone else wrote (web pages, pull requests, form submissions), and the
tool gate cannot pin a write's recipient or record. So no package puts a write or a send in its `allow`: each asks
until the owner grants it at apply (`grants`), and then it is the owner's choice, made on the screen that lists it. A
package's `allow` holds only the reads its unattended runs need. A test classifies every MCP tool a shipped package
lists as a read or a write, and refuses a write at `allow`.

**Scope the credentials.** An allowed read reaches whatever the saved credential reaches. Save `github` with a
fine-grained token for the one repository the agent works on, `hubspot` with the scopes its tools need, and so on: once
the owner grants a write, text the agent read could try to copy what that read reaches into it.

| Package | What it does | Started by | Needs |
|---|---|---|---|
| `code-review` | Reviews a pull request for real bugs and posts one comment review | a run naming a PR, or a GitHub webhook trigger the owner adds | the GitHub MCP server `github` to read and post; with none, a diff in the message |
| `kyb` | Business due diligence: identity, owners, sanctions against the lists themselves, adverse media, a verdict, every claim cited | a run naming a company | nothing; web tools only |
| `market-monitor` | A weekly digest of what changed at the companies you watch, posted to one Slack channel or address | a weekly schedule (its `cron` and `timezone` parameters, Monday 08:00 UTC by default), or a run | optional: Slack (`slack`) or Gmail (`gmail`) MCP, to send |
| `inbound-lead` | Researches a form or CRM lead, scores it against your ICP, writes back to HubSpot or posts to Slack | a webhook (needs the seal key): your form tool or relay signs Standard Webhooks bodies of type `lead.submitted`, each lead its own run (3 at once); or a run | optional: HubSpot (`hubspot`) or Slack (`slack`) MCP |
| `release-notes` | Turns the merged PRs since the last release into user-facing notes, as a draft issue to edit (no MCP tool makes a draft release) | a run naming the release or tag | the GitHub MCP server `github`; with none, a list of PRs in the message |

## Eval cases

Each `evals/<case>/` is one test of the package's agent. No eval runs on the server; the eval runner reads this layout
([Running the evals](#running-the-evals)).

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

## Running the evals

`agentrun template eval DIR` (the server's `agentrun-serve eval-template DIR`) runs a package's cases as real runs of its
agent and grades each run, so a package's quality bar is measured. **Real runs cost money**: each run is capped at its
case's `max_cost_usd`, and each `llm` grade is a run of its own, capped at $0.50.

| Flag | |
|---|---|
| `--case NAME` | A case to run; repeat it. Without one, every case. |
| `--runs N` | Runs of each case, in place of each case's `runs`. |
| `--server URL` | Run on that server instead, with its token as the CLI finds one (`AGENTRUN_API_KEY`, the CLI's config, or the data directory's for the server on this machine). The token goes to the runner over the launcher's pipe and is never printed. |
| `--grader-model PROVIDER/MODEL` | The `llm` graders' model. Absent: the server's default. |
| `--report FILE` | The whole report as JSON: per case, per run and per grader, its pass, its reason and its cost. A summary goes to stdout either way, progress to stderr. |
| `--faux MODULE` | Answer every model request from the module, as the server's `--faux` does: no key, no network. |

It exits 0 when every case passed, 1 when one failed, and 2 when nothing ran: a flag, the package or a case is wrong.
A Ctrl-C cancels the run in progress and cleans up as the end does (a second one leaves at once), and exits 130 with no
report.
Before anything runs, every case named is read and checked whole: the prompt's front matter, `case.yaml` against the
package (its parameters and grants as an apply checks them), each fake MCP server's fixture, each learned note as the
learning API checks one, and each grader's fields (an unknown field, a pattern that does not compile, a schema that
does not compile, a tool the package does not have).

**Where it runs.** By default on a server of its own, started in the command's process over a temp data directory that
holds a copy of the package alone and is removed at the end: the eval never touches your server, and needs the model
keys a server needs. With `--server`, everything goes through that server's v2 API: the package it ships by this name
must be this folder's (the agent an apply makes holds this folder's instructions and skill files, else the case fails
saying so), a case with a fake MCP server needs a server on this machine and fails rather than replace an MCP server
saved by the same name, and the agents the eval made are archived at the end.

**A case**, run by run:

1. Each `mcp` fixture is served as an MCP server on this machine's loopback and saved under its name with no
   credential; it records every call, with its arguments. It is removed after the case.
2. The package is applied with the case's `parameters` and `grants`: a fresh agent for each run, so what one run
   learns never reaches the next.
3. The `learning` folder's notes are written to the agent's learning folder (`PUT .../learning/files/{file}`); the
   server builds `MEMORY.md` from them, so the folder's own `MEMORY.md` is not sent.
4. A run starts with the prompt's body as its input and `max_cost_usd` as its cap, and is waited for (30 minutes at
   most, then cancelled and failed). A run that ends waiting on its person's answer (an `ask_person` question, a tool
   call's approval) is graded as it stands, then cancelled. One paused at its cap, stopped, failed or cancelled fails,
   its `llm` graders not run.
5. Each grader grades what the run left: its final answer, its tool calls (its timeline; and each fake's own log, with
   the whole arguments), and the files of its work folder.

A case passes when every grader passes on every run.

**The graders**, as the runner reads them:

- `schema`: the answer's last fenced `json` block (```` ```json ```` or a longer fence), parsed and checked against the
  schema, draft 2020-12 with `format` checked.
- `regex`: `pattern` with `flags` (some of `i`, `m`, `s`, `u`, `v`) over the whole answer, or over `target`, a field of
  the last `json` block (`a.b` for a nested one; a string as it is, anything else as its JSON). An answer with no such
  field fails the grader, whatever `expect` says.
- `tool_used`: the calls of `tool` (or any of `tools`) by gate name (`write`, `web_fetch`, `mcp:<server>/<tool>`). A
  faked MCP tool's calls are its fake's log, the calls that reached it; any other tool's are the timeline's. With
  `count`, exactly that many calls; else `expect: called`, one or more, or `not_called`, none. `args` keeps the calls
  that carry each of its arguments (an object's own fields compared the same way, any other value equal), and is
  allowed on a faked MCP tool only: the timeline keeps a call's input as a preview.
- `file_exists`: `path`, relative to the run's work folder, among its files.
- `llm`: a run of a grader agent on the same server, with no tools, a fixed instruction and the `--grader-model`. It is
  given the rubric, the run's input, its answer, its tool calls and the calls each fake received, and with `target`
  that field besides (the whole answer stays, for anything else the rubric checks). Never another grader, the case's
  description or anything the case expects. It answers `{pass, reason}` in a fenced `json` block; any other answer
  fails the grader.

The report gives each run's cost and each `llm` grade's, as their run records say, and the total.

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
| `mcp` | `[{server, tools, required?, allow?}]`: MCP servers by the name a server saves them under (Settings → MCP servers), the tools of each the agent uses (each one tool by its name, `A-Z a-z 0-9 _ . -`; never `*`), and `allow`, those of its tools the package asks the owner to allow (`GET /v2/templates` shows each tool with `asks: allow` or `ask`, for a consent screen). Where the server has one saved, apply grants `mcp:<server>/<tool>` for each, beside the other tools, at the owner's own setting: a package never sets a permission. Only the apply's `grants`, the owner's answer, are set to `allow`. Where it has none, apply skips it with a warning (`mcp.<server>`), or, when `required` is true, refuses with `409 agent_not_runnable` and makes nothing. |
| `computer` | `default` only, for now: the agent runs where this server puts a new one. |
| `parameters` | By name: `{type: string \| number \| integer \| boolean, required?, pattern? (strings), default?, description}`. Apply takes them in `parameters`, and one left out takes its `default`. `display_name`, the body, a trigger's `target.input` and a schedule's `cron` and `timezone` name them as `${parameters.<name>}`, nowhere else. A parameter a schedule uses has a default, and the package's own schedule is checked with it; apply checks every trigger with the parameters given before it makes anything, so a bad cron or zone is a `422` under `triggers.<i>`. |
| `secrets` | Variable names (never values) the server must hold: a model or tool key Settings saves (`OPENROUTER_API_KEY`, `PARALLEL_API_KEY`, ...), set where it starts or saved there. Any other name is refused: the server could neither save it nor hand it to a run. Apply refuses with `409 agent_not_runnable`, making nothing, when one is missing. |
| `budget` | `{per_run_usd}`: each run's cap (the agent's `max_cost_usd`). Required when the package has triggers. |
| `learning` | `true` or `false`: whether the agent's runs learn. |
| `triggers` | `POST /v2/triggers` bodies with no `agent_id` (the target is a `start_run`), each with a `name`, unique in the package: the key an upgrade will match triggers by. |
| `output` | `{schema: <file>}`: the JSON Schema of the agent's answer, a file in the package. It ships beside each SKILL.md, as a rule does, so the agent reads it there: the skill names it. |
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
   (it stays denied, with a `grants.<tool>` warning), its body held to `POST /v2/agents`' 1 MiB limit (`413`), its instructions
   the body with the parameters filled in, its skills and rules as its skill files, its harness and model chosen as
   above, `thinking` from `effort`, `max_cost_usd` from `budget`.
3. Each trigger is made on the agent through `POST /v2/triggers`' own function. One that still fails (the store, say)
   undoes the apply: the triggers made before it are deleted and the agent is archived, and the failure is the answer.
   A webhook trigger's secret is not in the answer: `POST /v2/triggers/{id}/secret` makes one.

Each apply makes a new agent. The same `Idempotency-Key` and body answers the first apply again and makes nothing.

A grant is written as the agent's own tool setting (`definition.tool_settings`), and an agent's setting outranks the
server's, as it does for any agent: a server-wide deny the owner sets after the apply does not reach that agent. To take
a grant back, edit the agent's `tool_settings`.
