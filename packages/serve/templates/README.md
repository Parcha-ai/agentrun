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

None needs a sandbox (code-review prefers a shell and runs without one): each reads and writes through web tools and MCP
servers the owner saves.

**Writes are bounded.** Every package reads content someone else wrote (web pages, pull requests, form submissions),
so no package puts a write in its own `allow`. A package whose job runs on triggers (code-review, inbound-lead,
market-monitor, release-notes) runs unattended (`approvals: never`), so the writes the owner ticks at apply don't ask (a
write left unticked is not granted at all): each is held by its pin,
which the tool gate checks before it allows or asks anything (a review can only COMMENT, a send only reaches the channel
set at apply, a draft issue is only ever created), or, where no pin can bound it, by a stated rule (a test lists both).
Apply writes each pin into the agent's own tool settings, so a pinned write never runs without its pin. The unpinned
writes a package offers for the owner's grant (code-review's pending-review comment, inbound-lead's CRM record) are the
rule-bounded ones above, and once granted they run unasked under `never`.

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
destination parameter apply was not given is set to deny, so it never runs, with a `pins.<tool>` warning that names
the parameter to give.

**Scope the credentials.** An allowed read reaches whatever the saved credential reaches. Save `github` with a
fine-grained token for the one repository the agent works on, `hubspot` with the scopes its tools need, and so on: once
the owner grants a write, text the agent read could try to copy what that read reaches into it.

| Package | What it does | Started by | Needs |
|---|---|---|---|
| `code-review` | Reviews a pull request for real bugs on a read-only checkout AgentRun makes of the PR (`checkout: pull_request`, in `repo/`): one `subagent` turn starts five quick and three deep reviewers, each with read-only bash (`git diff`, `git grep`, `nl -ba`; none builds or runs the code), against the repository's `CODEREVIEW.md` (on top of its own `rules/CODEREVIEW.md`, the baseline and the starter); the agent merges and verifies their findings and posts one comment review with P0/P1/P2 findings, each quoting the line behind it, and a 1-5 risk score, never an approval (its write is pinned to COMMENT). A fork's PR is reviewed when a writer comments `@<bot> review` | a run naming a PR, or a GitHub webhook trigger the owner adds | a shell (`computer: [shell, none]`: with none, it is made without bash and its reviewers read through the GitHub tools); the GitHub MCP server `github` to read the PR and post; with neither, a diff in the message |
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
  An answer is taken when every argument its `when` lists equals the call's, the first that does; else `default`. A
  `when` may be a list of such mappings, taken when any one matches (one answer for each spelling of a call: a file by
  `sha` or by `ref`). Each `result` is an MCP tool result. A tool may also hold `search`, `{query, files: [{path,
  text}], limit?, note?}`: a call no answer matches is answered by searching its `query` argument over those files
  (GitHub code search's syntax, read loosely: terms every one of which a file holds, `NOT` before a term or a
  qualifier, and `path:`, `filename:`, `extension:`, `language:`; a `/.../` term is read as literal text, never as a
  regular expression, so no query can stall the eval), as `path:line: text` lines, at most `limit` (100).
- `fixtures/`: what the case's fakes and notes read.
- `graders/*.md`, each one check of every run, by its front matter's `type`:
  - `llm`: the body is the rubric a blind grader applies to the answer (or to `target`, one field of the answer's JSON), with the run's tool calls (each with its preview) and the fake MCP servers' calls beside it, so a rubric can check what the run did, not only what it said.
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
| `model` | `{tier: fast \| balanced \| strong, prefer?: "provider/model-id"}`. Apply uses `prefer` when this server runs it on the chosen harness (it holds that provider's key and reaches models directly, not through a gateway); otherwise the server's model for the tier: `AGENT_MODEL_FAST`, `AGENT_MODEL` (balanced) or `AGENT_MODEL_STRONG`, each else the default of a model key the server holds. `overrides.model` in the apply wins over both. On a server that reaches its models through a gateway (`AGENT_MODEL_BASE_URL`), `prefer` is not used, since the gateway never said it serves it, and a tier model that is the gateway's own id (no `provider/`) is left out, so the agent runs on the server's default; each is said in a `model` warning. `fast` and `strong` (each `"provider/model-id"`, optional) name the model the agent's `subagent` calls run on for that tier, kept by the same rule as `prefer` (else the server's model for the tier, with a `model` warning); the agent's own tier, named in neither, is the agent's own model. Apply writes them as the definition's `model_tiers`. Absent: the server's default. |
| `effort` | The thinking level: `low`, `medium`, `high`, `xhigh` or `max`. |
| `tools` | The tools the agent is granted, never an MCP tool (`mcp` grants those). `subagent` (pi only) lets the agent run a fresh conversation with a prompt and a subset of its own tools (MCP tools and `bash` included, `bash` held to the agent's `tool_policy`), on the agent's own model or one of its tiers (`fast`, `strong`) when the call names one, under its permissions and cap, and get the child's final text back, with `max_tool_calls` (narrowing the agent's budget, never widening it) and `effort` (`low`, `medium`, `high`) of its own when the call names them; several in a turn run at once, at most 4. A skill can use it to sample K answers, merge them and verify each before acting ([patterns](../README.md#patterns)). Absent: those the server gives a new agent (its box's shell, where it has a box). |
| `mcp` | `[{server, tools, required?, allow?, pin?}]`: MCP servers by the name a server saves them under (Settings → MCP servers), the tools of each the agent uses (each one tool by its name, `A-Z a-z 0-9 _ . -`; never `*`), and `allow`, those of its tools the package asks the owner to allow (`GET /v2/templates` shows each tool with `asks: allow` or `ask`, for a consent screen). Where the server has one saved, apply grants `mcp:<server>/<tool>` only for each tool the apply's `grants` (the owner's answer) name, beside the other tools, set to `allow`: a package never grants a tool or sets a permission itself. A tool the owner leaves out is not the agent's at all, under `approvals: never` too, so no harness offers it and a call of it is refused; the owner can grant it later in the agent's tools. Where it has none, apply skips it with a warning (`mcp.<server>`), or, when `required` is true, refuses with `409 agent_not_runnable` and makes nothing. `pin`, optional: `{<tool>: {<argument>: <value>}}`, for tools of the entry, 1 to 8 top-level arguments each, every value a scalar (text, which may be or hold `${parameters.<name>}`, a number, `true`/`false`, or `null` for an argument that must be left out) or a list of 1 to 16 of them, the argument one of the list (`event: [null, COMMENT]`), kept with each value once, null first, then by its JSON text. Apply writes it, filled, as the tool's `pin` in the agent's `tool_settings` (text that is one placeholder alone takes the parameter's value and type), whatever the tool's permission, and the gate refuses any call not as pinned; a pin the server's own settings (Settings → Tools) set for the tool holds too. A pin whose parameter apply is not given sets the tool to `deny` instead, granted or not, with a `pins.mcp:<server>/<tool>` warning. `GET /v2/templates` shows each tool's `pin`, unfilled. |
| `tool_policy` | `{bash: read-only}`: a policy on the agent's bash, the one tool that takes one. Apply writes it as `policy` on bash in the agent's `tool_settings` (`definition.tool_settings.bash.policy`), whatever bash's permission, and the tool gate reads each shell call's command before it runs or anyone is asked. Under `read-only` it refuses, in words the model reads, any command that could write, run code or read outside the run's folder: a program outside the read list (git's read subcommands `diff`, `show`, `log`, `blame`, `grep`, `ls-files`, `ls-tree`, `rev-parse`, `cat-file`, `merge-base`, `status`, `shortlog`, `rev-list`, `diff-tree`, `name-rev`, `describe`; `grep`, `egrep`, `fgrep`, `rg`, `sed -n 'N,Mp'`, `cat`, `head`, `tail`, `wc`, `nl`, `ls`, `find` without `-exec` or `-delete`, `sort`, `uniq`, `cut`, `tr`, `diff`, `basename`, `dirname`, `echo`, `true`), a redirection other than `2>/dev/null` and `2>&1`, `$` and backticks, a subshell, `\|\|` or a lone `&`, a pipe into anything but a filter (`head`, `tail`, `sed -n`, `grep`, `wc`, `sort`, `uniq`, `cut`, `tr`, `nl`), an unquoted glob (a glob is quoted, and only in a grep pattern, an `--include=` value or a `find -name` value), a path outside the run's folder, or one on the never-open list (`.env*`, `.ssh/`, `id_rsa*`, `*.pem`, `*.key`, `.npmrc`, `.netrc`, `.git-credentials`, `credentials`), which refuses a command that names such a file but is no fence around the folder: a recursive search reads all it holds, the run's own files and never a key of the server's. `git -C <dir>` is allowed to a directory inside the folder. A line with a `cd` joins its commands with `&&` only. `bash_background` and `bash_input` are refused under it. The check reads the command, never the folder, so a symbolic link in the folder reaches what the computer lets it; and it holds bash alone, so a read-only agent's tools are `read` and `bash` (one that may write can change what git obeys). Approvals `never` lifts none of it. A package with `tools` grants `bash` among them. |
| `computer` | `default` (or absent): the agent runs where this server puts a new one. Or a preference list, `[shell, none]`, read like `harness`: apply takes the first entry this server meets now and saves it as the agent's `computer`. `shell` is a computer that gives the agent a shell here: Archil's serverless exec on the runner when Archil is on (Settings → Workspace; `bash` alone, so `bash_background` and the other background tools are not granted), else the Docker sandbox where Docker answers. `none` is no shell, and is always met: the shell tools in `tools` (`bash` and the background tools) are not granted, and neither is `tool_policy`'s bash. A package with no `tools` is given the chosen shell's tools, as a new agent in a box is given the box's. A fallback, or a tool not granted, is said in a `computer` warning on the apply. A list with `shell` alone, where there is none, refuses the apply (`409`, nothing made). A list without `shell` grants no shell tool, so one in `tools` is refused, and so is an entry after `none`, which would never be picked. The choice is made at apply: a server that gains a shell later gives it to an agent applied again. `GET /v2/templates` shows the list as `computer`, and as `computer_here` what an apply here would pick now: the entry, the agent's `computer`, the shell in words, the tools it would not grant, and the warning or refusal. |
| `checkout` | `pull_request` only: apply sets the agent definition's `checkout`, and the server checks out the pull request each run's GitHub event names before its first turn, in `repo/` of the run's folder, detached at the head, with its base and their merge base (refs `pr/head`, `pr/base`, `pr/merge-base`: `git diff pr/merge-base pr/head` reads the change). The server fetches it with its GitHub App's token, narrowed to that one repository and `contents: read` and revoked after the fetch, or anonymously with no App; the agent never holds a token, and nothing of it is left in the folder or the checkout's git config. The run's system prompt says what was checked out, or why nothing was, so the package's instructions can fall back to the GitHub MCP. It is removed when the run's claim ends. With `tool_policy: {bash: read-only}` the agent reads it with git's read subcommands and never fetches itself. |
| `parameters` | By name: `{type: string \| number \| integer \| boolean, required?, pattern? (strings), enum?, default?, description}`. `enum` lists a closed set of values, which a form shows as a choice; give it instead of a pattern. The `description` is what a person reads beside the field, never the pattern, so say the format in it ("a Slack channel ID like C0123ABCD"). Apply takes them in `parameters`, and one left out takes its `default`. `display_name`, the body, a trigger's `target.input`, a schedule's `cron` and `timezone` and an `mcp` entry's `pin` values name them as `${parameters.<name>}`, nowhere else. A parameter a schedule uses has a default, and the package's own schedule is checked with it; apply checks every trigger with the parameters given before it makes anything, so a bad cron or zone is a `422` under `triggers.<i>`. |
| `secrets` | Variable names (never values) the server must hold: a model or tool key Settings saves (`OPENROUTER_API_KEY`, `PARALLEL_API_KEY`, ...), set where it starts or saved there. Any other name is refused: the server could neither save it nor hand it to a run. Apply refuses with `409 agent_not_runnable`, making nothing, when one is missing. |
| `budget` | `{per_run_usd?, tool_calls?}`, one at least: `per_run_usd` is each run's cap (the agent's `max_cost_usd`), required when the package has triggers; `tool_calls` is the tool calls each conversation of a run may make (the agent's `max_tool_calls`): past it every call is refused with words that say to answer now, so a reviewer told "about 30 calls" is held to 30. |
| `learning` | `true` or `false`: whether the agent's runs learn. |
| `approvals` | `ask` (the default: the agent asks its person before a tool runs) or `never` (it runs unattended). The package's recommendation, shown as `approvals_default` for the apply screen; a template whose job runs on triggers says `never`. `never` only skips asking for the tools the agent was granted: an MCP tool the owner left unticked at apply is not one. Deny settings and pins hold either way. |
| `triggers` | `POST /v2/triggers` bodies with no `agent_id` (the target is a `start_run`), each with a `name`, unique in the package: the key an upgrade will match triggers by. |
| `output` | `{schema: <file>}`: the JSON Schema of the agent's answer, a file in the package. It ships beside each SKILL.md, as a rule does, so the agent reads it there: the skill names it. |
| `checks` | Names of structural checks of a run's answer; none runs yet. |

The check is whole: the package is compiled with a sample of each parameter, and the agent body and each trigger body are
checked as `POST /v2/agents` and `POST /v2/triggers` check theirs (all but the agent a trigger names, which apply makes).
A tool the server does not bind, a trigger field or schedule it refuses, or a skill file's path is refused here, not at
apply. A trigger's date is checked for its form only: one that has passed is refused at apply, never at a server's start. A package holds at most 256 files, each at most 256 KiB, and 1 MiB together (`POST /v2/agents`' own body limit).

## Installing a package from GitHub

A package on GitHub installs beside the bundled ones: `POST /v2/templates/import` with
`{source, dry_run?, trust_publisher?}`, `agentrun template install <source> [--dry-run] [--trust]`, or the console's
"Add from URL" box on Templates. The source is `github:<owner>/<repo>[/<path>][@<ref>]` (the package's folder at
`<path>`, the default branch without a ref), or the folder's `https://github.com/<owner>/<repo>/tree/<ref>/<path>`.
The ref follows the last `@`, so a path with an `@` in it (`packages/@acme/kyb`) names its ref.

1. The ref is resolved to a full commit SHA, then that commit's tarball is read from GitHub (github.com,
   api.github.com and codeload.github.com, no redirect elsewhere), with the server's GitHub App token when it has one,
   else anonymously. Nothing is written to disk and nothing in the package runs.
2. The folder at `<path>` is taken from it and checked as the bundled packages are: a symbolic or hard link, a special
   file, more than 8 MiB of files, or an archive over 128 MiB is refused (`422`), as is a package that does not check.
3. A dry run answers the package whole (its instructions and every skill file) and stores nothing. Otherwise it is
   stored under its id, `github:<owner>/<repo>[/<path>]`, listed by `GET /v2/templates` with `bundled: false`, its
   `source`, `sha` and `publisher`, and applied as below with that id URL-encoded. Importing the id again replaces it;
   `DELETE /v2/templates/{id}` removes it (a bundled package is `403`). Agents applied from it stay as they are, each with
   `template: {id, version, sha}`.

The first package from a publisher (the GitHub owner) is stored only with `trust_publisher: true`, which the server
remembers: read it first with a dry run. A trust says the owner's packages may be stored; it grants no tool. Each apply
still asks for each grant.

## Apply

`POST /v2/templates/{id}/apply` with `{parameters, grants?, overrides?: {model}}` (a bundled package's id is its name):

1. The parameters and `grants` are checked against the package (`422` naming each field: a grant is one of the
   package's MCP tools by its gate name, `mcp:<server>/<tool>`), then its secrets, its required MCP servers and, for a
   webhook trigger, the server's seal key (`409`), then every trigger as `POST /v2/triggers` checks it, its parameters
   filled (`422` under `triggers.<i>`). Nothing is made yet.
2. The agent is made through `POST /v2/agents`' own function: named by `display_name` (else the package's name),
   described as the package, granted the MCP tools in `grants` alone where their server is saved, each set to `allow`
   (a tool left out is not granted), never `allow` for one the owner denies on this server (it stays denied, with a
   `grants.<tool>` warning), each pinned tool with its pin filled (or set to `deny`, with a
   `pins.<tool>` warning, when its parameter was not given), bash's policy from `tool_policy`, its computer the first
   entry of `computer` this server meets (a fallback said in a `computer` warning), its body held to `POST /v2/agents`' 1 MiB limit (`413`), its instructions
   the body with the parameters filled in, its skills and rules as its skill files, its harness and model chosen as
   above, `thinking` from `effort`, `max_cost_usd` and `max_tool_calls` from `budget`.
3. Each trigger is made on the agent through `POST /v2/triggers`' own function. One that still fails (the store, say)
   undoes the apply: the triggers made before it are deleted and the agent is archived, and the failure is the answer.
   A webhook trigger's secret is not in the answer: `POST /v2/triggers/{id}/secret` makes one.

Each apply makes a new agent. The same `Idempotency-Key` and body answers the first apply again and makes nothing.

A grant is written as the agent's own tool setting (`definition.tool_settings`), and an agent's setting outranks the
server's, as it does for any agent: a server-wide deny the owner sets after the apply does not reach that agent. To take
a grant back, edit the agent's `tool_settings`.
