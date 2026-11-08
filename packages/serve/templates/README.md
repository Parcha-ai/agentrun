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

## agent.md

| Field | |
|---|---|
| `name` | Required. The folder's name: lowercase letters, digits and dashes, at most 64. |
| `display_name` | The agent's name; it may hold `${parameters.<name>}`. Absent: the package's name. |
| `version` | Required. SemVer 2 (`0.1.0`), kept on the agent as `package.version`. Never `definition.version`, which is the agent's revision number; a bare number is refused. |
| `description` | Required. Also the agent's description. |
| `license`, `author` (`{name, email?, url?}`), `repository` | Optional, shown in the list. |
| `harness` | A preference list (`[pi, claude-agent]`): apply takes the first this server runs, else the first. Absent: the server's default. |
| `model` | `{tier: fast \| balanced \| strong, prefer?: "provider/model-id"}`. Apply uses `prefer` when this server runs it on the chosen harness (it has the provider's key, or a gateway); otherwise the server's model for the tier: `AGENT_MODEL_FAST`, `AGENT_MODEL` (balanced) or `AGENT_MODEL_STRONG`, each else the default of a model key the server holds. `overrides.model` in the apply wins over both. Absent: the server's default. |
| `effort` | The thinking level: `low`, `medium`, `high`, `xhigh` or `max`. |
| `tools` | The tools the agent is granted, never an MCP tool (`mcp` grants those). Absent: those the server gives a new agent (its box's shell, where it has a box). |
| `mcp` | `[{server, tools, required?}]`: MCP servers by the name a server saves them under (Settings → MCP servers), and the tools of each the agent uses. Where the server has one saved, apply grants `mcp:<server>/<tool>` for each, beside the other tools, and sets each to `allow` in the agent's tool settings, so a triggered run never waits on an ask. Where it has none, apply skips it with a warning (`mcp.<server>`), or, when `required` is true, refuses with `409 agent_not_runnable` and makes nothing. |
| `computer` | `default` only, for now: the agent runs where this server puts a new one. |
| `parameters` | By name: `{type: string \| number \| integer \| boolean, required?, pattern? (strings), description}`. Apply takes them in `parameters`; the body and the triggers name them as `${parameters.<name>}`. |
| `secrets` | Variable names (never values) the server must hold, set where it starts or saved as a key. Apply refuses with `409 agent_not_runnable`, making nothing, when one is missing. |
| `budget` | `{per_run_usd}`: each run's cap (the agent's `max_cost_usd`). Required when the package has triggers. |
| `learning` | `true` or `false`: whether the agent's runs learn. |
| `triggers` | `POST /v2/triggers` bodies with no `agent_id` (the target is a `start_run`), each with a `name`, unique in the package: the key an upgrade will match triggers by. |
| `output` | `{schema: <file>}`: the JSON Schema of the agent's answer, a file in the package. |
| `checks` | Names of structural checks of a run's answer; none runs yet. |

## Apply

`POST /v2/templates/{name}/apply` with `{parameters, overrides?: {model}}`:

1. The parameters are checked against the package (`422` naming each field), then its secrets and required MCP servers
   (`409`). Nothing is made yet.
2. The agent is made through `POST /v2/agents`' own function: named by `display_name` (else the package's name),
   described as the package, its MCP tools granted and allowed where their server is saved, its instructions
   the body with the parameters filled in, its skills and rules as its skill files, its harness and model chosen as
   above, `thinking` from `effort`, `max_cost_usd` from `budget`. Its revision keeps the record
   `package: {name, version, source: "builtin", ref: null, sha: null, parameters}`, which `GET /v2/agents/{id}` shows
   and an edit by hand keeps.
3. Each trigger is made on the agent through `POST /v2/triggers`' own function. One the server refuses undoes the
   apply: the triggers made before it and the agent are deleted, and the refusal is the answer, its fields under
   `triggers.<i>`. A webhook trigger's secret is not in the answer: `POST /v2/triggers/{id}/secret` makes one.

Each apply makes a new agent. The same `Idempotency-Key` and body answers the first apply again and makes nothing.
