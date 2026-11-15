# Template packages

A template package is one folder that makes a working agent: its manifest, its instructions, its skills, its rules and
its evals. The server ships the packages in this folder, checks each one whole at its start (a broken one stops the
start), lists them at `GET /v2/templates` and applies one with `POST /v2/templates/{name}/apply`. Nothing in a package
runs at apply: it is read, checked, and made into the same agent and trigger records `POST /v2/agents` and
`POST /v2/triggers` make. `agentrun template validate DIR` runs the server's own check on a folder.

[Giving a template tools](TOOLS.md) is the short guide to declaring, pinning and approving a template's tools.

```
code-review/
  agent.md                 front matter = the whole manifest; body = the agent's instructions
  skills/<name>/SKILL.md   Agent Skills: front matter names the skill (= its folder) and describes it
  rules/*.md               rules each skill reads: apply puts a copy beside each SKILL.md
  evals/<case>/prompt.md   a case's run input (front matter: description, runs, max_cost_usd, ...)
  evals/<case>/graders/*.md   front matter `type`: llm, regex, tool_used or file_exists
  evals/<case>/case.yaml, evals/<case>/fixtures/   optional
  skills/review/findings.schema.json   any other file the manifest names (here the answer's schema, which the
                           reviewers' guides beside it read too)
```

Links and other special files are refused anywhere in the folder, and its only folders are `skills/`, `rules/` and
`evals/`. The server checks evals for their layout only and runs none; `agentrun template eval DIR` runs them
([Running the evals](#running-the-evals)).

## The packages this server ships

None needs a sandbox (code-review prefers a shell and runs without one): each reads and writes through web tools and MCP
servers the owner saves.

**Writes are bounded.** Every package reads content someone else wrote (web pages, pull requests, form submissions),
so no package puts a write in its own `allow`. A tool the owner ticks at apply is granted, not allowed: apply writes
no permission for it, so it follows this server's tool settings: under `approvals: ask` a ticked write asks the owner
first unless the owner allowed it in Settings → Tools, and a ticked read runs unasked only where the owner turned on
Allow reads for its server. A package whose job runs on triggers (code-review, inbound-lead,
market-monitor, release-notes) runs unattended (`approvals: never`), so the writes the owner ticks at apply don't ask (a
write left unticked is not granted at all): each is held by its pin,
which the tool gate checks before it allows or asks anything (a review can only COMMENT, a send only reaches the channel
set at apply, a draft issue is only ever created), or, where no pin can bound it, by a stated rule (a test lists both).
Apply writes each pin into the agent's own tool settings, so a pinned write never runs without its pin. The unpinned
writes a package offers for the owner's grant (inbound-lead's HubSpot note, whose destination is a contact that differs
each run) are the rule-bounded ones above, and once granted they run unasked under `never`. No package offers a write
whose object argument a pin can't bound: inbound-lead puts the fit score in its note's text, not in a contact update
that could overwrite any field. A package that holds `web_fetch` reads nothing through MCP: text it reads could have it
put private data in a URL it fetches, so inbound-lead takes its contact from the CRM event's own payload and never reads
the CRM.

**Every scoped tool is pinned, reads too.** A package that reads text anyone can write pins every MCP tool that takes a
scope argument (a GitHub `owner` and `repo`, a channel) to its parameters, reads as well as writes, so a hostile pull
request, release or page can't have a read reach another repository the credential reaches and a write quote it where
its author reads it. A free-text search across everything the credential sees (GitHub's `search_code`,
`search_issues`, `search_pull_requests`) can't be pinned, so no package uses one: they list and read instead. A
repository is two parameters, `owner` and `repo`, because GitHub's tools take them apart. `code-review` and
`release-notes` pin each of their GitHub tools to them, and each has an eval case (`other-repo`) where the untrusted text
asks for another repository's file.

**A pinned send goes only where the owner set.** A package may pin a send's destination to a parameter (`pin` in its
`mcp` entry): apply writes it into the agent's tool settings, and the server's tool gate refuses any call of that tool
whose destination is not the pinned one, before it is sent or asked about, even once the owner granted the tool. So
a page that talks the agent into posting elsewhere gets a refusal, never a post. A pin fixes where a send goes, not
what it says. A write to a record (a CRM contact) can be fenced to the fields it may set with a keys pin
(`properties: {keys: ["${parameters.crm_score_property}"]}`): a call that sets any other field is refused; which record
it writes is held by its skill's own check, or by a pin of the record's id. A pinned tool takes only the arguments
its listing declares, so an alias the server takes for a pinned argument that the listing does not declare (Gmail's
`to` beside `recipient_email`) is refused without a pin of its own.
`market-monitor` pins `SLACK_SEND_MESSAGE`'s `channel` and `GMAIL_SEND_EMAIL`'s `recipient_email` to its `channel`
parameter (and keeps `cc`, `bcc`, `extra_recipients` and `from_email` out), and `inbound-lead` pins
`SLACK_SEND_MESSAGE`'s `channel` to its `slack_channel` (both Composio actions). Neither pins the name the action
also takes the destination by (Slack's `channel_id`, Gmail's `to`): neither listing declares it, so the gate refuses
it. `market-monitor`'s `channel` takes a Slack channel id or an email address: each
pin applies only to its own tool, so a channel id leaves no address `GMAIL_SEND_EMAIL` can send to and an address no
channel Slack can post in, and its skill sends with the tool that matches the destination's kind. A send whose
destination parameter apply was not given is set to deny, so it never runs, with a `pins.<tool>` warning that names
the parameter to give.

**Scope the credentials.** An allowed read reaches whatever the saved credential reaches, less what a pin holds it from.
Install the GitHub App only on the repositories its agents work on, connect the HubSpot toolkit with the scopes its
tools need, and so on: once
the owner grants a write, text the agent read could try to copy what that read reaches into it.

| Package | What it does | Started by | Needs |
|---|---|---|---|
| `code-review` | Reviews a pull request for real bugs on a read-only checkout AgentRun makes of the PR (`checkout: pull_request`, in `repo/`): one `subagent` turn starts five quick and three deep reviewers, each with read-only bash (`git diff`, `git grep`, `nl -ba`; none builds or runs the code), against the repository's `CODEREVIEW.md` (on top of its own `rules/CODEREVIEW.md`, the baseline and the starter); the agent merges and verifies their findings and posts one comment review with P0/P1/P2 findings, each quoting the line behind it, and a 1-5 risk score, never an approval (its write is pinned to COMMENT). A fork's PR is reviewed when a writer comments `@<bot> review` | a run naming a PR, or a GitHub webhook trigger the owner adds | a shell (`computer: [shell, none]`: with none, it is made without bash and its reviewers read through the GitHub tools); a saved GitHub MCP server (source `github`, on the GitHub App) to read the PR and post, every call pinned to its `owner` and `repo`; with neither, a diff in the message |
| `kyb` | Business due diligence: identity, owners, sanctions against the lists themselves, adverse media, a verdict, every claim cited | a run with the company as typed input (`company`, and optionally `website`, `country`, `registration_number`, `reason`) | nothing; web tools only |
| `market-monitor` | A weekly digest of what changed at the companies you watch, posted to one Slack channel or address | a weekly schedule (its `cron` and `timezone` parameters, Monday 08:00 UTC by default), or a run | optional: a saved Composio Slack or Gmail MCP server (toolkit `slack` or `gmail`), to send |
| `inbound-lead` | Researches a form or CRM lead, scores it against your ICP, adds a note with the score to the lead's HubSpot contact or posts to Slack | a webhook (needs the seal key): your form tool or relay signs Standard Webhooks bodies of type `lead.submitted`, each lead its own run (3 at once); or a run | optional: a saved Composio HubSpot or Slack MCP server (toolkit `hubspot` or `slack`) |
| `release-notes` | Turns the merged PRs since the last release into user-facing notes, as a draft issue to edit (no MCP tool makes a draft release) | a run naming the release or tag | a saved GitHub MCP server (source `github`, on the GitHub App), every call pinned to its `owner` and `repo`; with none, a list of PRs in the message |

## Eval cases

Each `evals/<case>/` is one test of the package's agent. No eval runs on the server; the eval runner reads this layout
([Running the evals](#running-the-evals)).

- `prompt.md`: its body is the run's input, written as the agent receives it (a webhook case as the trigger delivers
  it: the trigger's words, then the body in `<trigger-payload ... untrusted>`). Front matter: `description`, `runs`
  (how many times; the case passes when every run passes), `max_cost_usd` (each run's cap), and, for a package with
  `inputs`, `input` (the run's typed input, a mapping by field: `input: {company: Apple Inc., country: US}`). The run's
  input is the body as `content` (none when the body is empty) and those fields, checked against the package's input
  schema as the server checks a run's, so a case its schema refuses fails before any run. The model reads them as the
  server writes them, under `Input:`; a body that holds its own `Input:` block is refused.
- `case.yaml`, optional: `parameters` (the apply's parameters), `grants` (the gate names the apply grants, always a
  list), `mcp` (an `mcp` need's toolkit to a fixture file in the case that fakes it), `learning` (a folder of notes in the case
  the agent starts with: `MEMORY.md` and its notes), `web` (fakes `web_search` and `web_fetch` for the case's runs),
  `monid` (fakes the package's monid endpoints for the case's runs), `now` (the case's clock), `email` (a fake mailbox
  for the case's runs).
- `web: unavailable`: every `web_search` answers with the words a rate-limited free search answers with, and every
  `web_fetch` fails as a page that never answers does; no call reaches the network. `web:` a fixture file in the case
  answers from that file instead:
  ```json
  { "search": { "answers": [ { "query": "robot", "results": [ { "url": "https://...", "title": "...", "snippet": "...", "published": "2026-11-10" } ] },
                            { "query": "^outage", "error": "Parallel's search answered 503" } ],
                "default": { "results": [] } },
    "fetch": { "answers": [ { "url": "https://.../post", "title": "...", "text": "the page's text" },
                            { "url": "https://.../gone", "status": 404, "text": "" } ],
               "default": { "error": "fetch failed" } } }
  ```
  A search answer's `query` is a regular expression over the call's query (case-insensitive), a fetch answer's `url`
  the exact URL; the first answer that matches is taken, else `default`. A `status` of 400 or more fails the fetch as
  that answer would. The calls show in the run's timeline as any other, so a `tool_used` grader counts them. Each
  harness gets the same fake: on claude-agent and codex their own web search is never offered to a `web:` case's runs.
  The package's `tools` must name `web_search` or `web_fetch`. Only the eval's own server honours `web`, so a case with
  it refuses to run with `--server`.
- `monid: unavailable`: every call of a monid endpoint the package grants answers as it does when monid can't be
  reached (`... was not sent: monid's price for it could not be read before the call (monid could not be reached: fetch
  failed).`): never sent, nothing held or charged, and shown in the timeline under its monid name, so a `tool_used`
  grader counts it. The apply still reads monid's listing to pin the endpoints (free, no run), so the agent sees the
  tools it sees live and needs `MONID_API_KEY` as a live eval does. The package must grant a monid endpoint; only the
  eval's own server honours `monid`, so a case with it refuses `--server`. `unavailable` is its only value.
- `now: 2026-11-14T09:00:00Z`, a date and time with its offset: each run's current date and time. The run's environment
  line says that day ("Today is 2026-11-14 (UTC)"), as does claude-agent's turn date, and each `llm` grader is told it,
  so a rubric can say "the run's date". A tool that reads the machine's clock (a shell's `date`, a browser's page) and
  a harness CLI's own date (Codex adds its own to each turn) still read the real one. A fixture case whose prompt or
  pages carry dates sets `now:`, else it drifts a day each day it is run. Only the eval's own server honours it: a case with `now` refuses
  `--server`. Without it, the real clock.
- `email: fixtures/mailbox.json`, a fixture file in the case: each run gets a fake mail account of its own, seeded from
  it and saved as the server's email account (plaintext, on this machine's loopback), closed after the run, so no run
  reads real mail or shares another's mailbox. The fixture:
  ```json
  { "description": "Two threads in the inbox, and a new reply on the first.",
    "account": { "address": "agent@acme.example" },
    "layouts": ["gmail", "folders"],
    "mailboxes": { "INBOX": [ { "from": "ana@example.com", "to": ["agent@acme.example"], "subject": "Invoice 1042",
                                "date": "2026-11-13T10:00:00Z", "message_id": "<a1@example.com>", "text": "..." } ],
                   "Drafts": [], "Sent": [], "Ignored": [] },
    "message": { "from": "ana@example.com", "to": ["agent@acme.example"], "subject": "Re: Invoice 1042",
                 "date": "2026-11-14T08:00:00Z", "message_id": "<a2@example.com>", "in_reply_to": "<a1@example.com>",
                 "references": ["<a1@example.com>"], "text": "Any news?" },
    "trigger": "New mail" }
  ```
  A message is the email trigger's payload (`from`, `from_name`, `to`, `cc`, `subject`, `date`, `message_id`,
  `in_reply_to`, `text`, `attachments`) plus `flags` and `references`; it is checked when the case is read. `layouts`
  (default `[folders]`) are the kinds of server each run repeats on, reported per layout: `gmail` (a folder is a label,
  and searching a label's mailbox finds every message under it, as Gmail's does; filing labels a message,
  `archive: true` takes it out of the inbox) and `folders` (every other server; filing moves a
  message, so `email_file` with `archive: false` is refused and nothing moves). The fake runs the real email tools, so
  filing on it is the tools' own rule. A mailbox the fixture names with no messages (`Receipts: []`) is made empty. A
  run starts as its trigger would, never as an ordinary run with the payload pasted in: the mailboxes are seeded, the
  package is applied (its email trigger takes its start there), `message` is delivered to the mailbox the trigger
  watches (INBOX by default), and the trigger's next poll fires on it, so the run reads only that message's thread. A fixture with no `message` starts the package's schedule's run instead, which reads the whole
  account. `trigger` names the trigger when the package has more than one of that kind. The case's `prompt.md` holds
  `description` and `runs` alone: the run's input and cap are the trigger's. The run's clock, and the date of what it
  drafts, is the case's `now`. Its graders see each email call with its arguments (a refused one too, which still
  counts as a call for `tool_used`) and `<mailbox-after>`: the messages it added (each draft's to, cc, subject,
  in_reply_to and text), the ones it moved or labelled (`message_id`, before and after, labels), and those it sent
  (SMTP). The package's `tools` must name an email tool; only the eval's own server honours `email`, so a case with
  it refuses `--server`.
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
  - `llm`: the body is the rubric a blind grader applies to the answer (or to `target`, one field of the answer's JSON), with the run's tool calls (each with its arguments and the head of its result) and the fake MCP servers' calls beside it, so a rubric can check what the run did, not only what it said.
  - `regex`: `pattern` over the answer (or `target`), with `flags` and `expect: match` (the default) or `no_match`.
  - `tool_used`: `tool` (or `tools`, a list), `expect: called` (the default) or `not_called`, and optionally `args` (the
    arguments a call must carry) and one of `count` (exactly that many matching calls) or `at_least` (that many or more,
    so a run that searches once more than the case needs still passes).
  - `file_exists`: `path` in the run's work folder.
  - `mailbox`, on an `email` case: `message_id` is `in` a mailbox (or, on gmail, under a label) after the run, and in
    none of `not_in` (a list); `INBOX`, `Drafts` and `Sent` name the account's own on either layout. `in: INBOX` is
    the check that a message stayed in the inbox on both layouts: a gmail label keeps it there, a folders move does not.

  On an `email` case any grader may say `layouts` (`[gmail]`, `[folders]`): it grades the runs of those layouts alone,
  where a package's right behaviour differs by server (on folders, `tool_used` `email_file` `not_called`; on gmail,
  `count: 1` with `args: {archive: false}`). On a run of another layout it is not one of the run's graders.

  The answer's shape needs no grader: every completed run of a package with `output` is held to its schema.

## Running the evals

`agentrun template eval DIR` (the server's `agentrun-serve eval-template DIR`) runs a package's cases as real runs of its
agent and grades each run, so a package's quality bar is measured. **Real runs cost money**: each run is capped at its
case's `max_cost_usd`, and each `llm` grade is a run of its own, capped at $0.50.

| Flag | |
|---|---|
| `--case NAME` | A case to run; repeat it. Without one, every case. |
| `--runs N` | Runs of each case, in place of each case's `runs`. |
| `--server URL` | Run on that server instead, with its token as the CLI finds one (`AGENTRUN_API_KEY`, the CLI's config, or the data directory's for the server on this machine). The token goes to the runner over the launcher's pipe and is never printed. |
| `--on-data DIR` | Run the eval's own server on DIR, a stopped server's data folder, in place of a temp one: the runs use what that server keeps (its ChatGPT sign-in, so a package is measured on the owner's plan), and every case's fakes still bind (`now`, `email`, `web`, `monid`). The agents the eval made are archived there, and the folder stays. Refused with `--server`, while another server holds DIR, and for an email case when DIR's server keeps an email account, which the case's fake mailbox would replace. |
| `--grader-model PROVIDER/MODEL` | The `llm` graders' model. Absent: the server's default. |
| `--report FILE` | The whole report as JSON: per case, per run and per grader, its pass, its reason and its cost. A summary goes to stdout either way, progress to stderr. |
| `--faux MODULE` | Answer every model request from the module, as the server's `--faux` does: no key, no network. |

It exits 0 when every case passed, 1 when one failed, and 2 when nothing ran: a flag, the package or a case is wrong.
A Ctrl-C cancels the run in progress and cleans up as the end does (a second one leaves at once), and exits 130 with no
report.
Before anything runs, every case named is read and checked whole: the prompt's front matter, `case.yaml` against the
package (its parameters and grants as an apply checks them), each fake MCP server's fixture, each learned note as the
learning API checks one, and each grader's fields (an unknown field, a pattern that does not compile, a tool the
package does not have).

**Where it runs.** By default on a server of its own, started in the command's process over a temp data directory that
holds a copy of the package alone and is removed at the end: the eval never touches your server, and needs the model
keys a server needs. With `--server`, everything goes through that server's v2 API: the package it ships by this name
must be this folder's (the agent an apply makes holds this folder's instructions and skill files, else the case fails
saying so), a case with a fake MCP server needs a server on this machine and fails rather than replace an MCP server
saved by the same name, and the agents the eval made are archived at the end. That server records what made each MCP
server, so a fake there is a `url` one with its toolkit: a case that fakes a `composio` or `github` need fails there,
and runs on the eval's own server.

**A case**, run by run:

1. Each `mcp` fixture is served as an MCP server on this machine's loopback and saved under its toolkit's name, with
   no credential, standing in for the need: the eval's own server records it as the need's source and toolkit (a
   `github` one too, which on any other server only the GitHub App's tokens are). It records every call, with its
   arguments, and is removed after the case.
2. The package is applied with the case's `parameters` and `grants`: a fresh agent for each run, so what one run
   learns never reaches the next. Every eval applies with approvals `never`, on its own server and with `--server`
   alike (see below), so a granted tool runs with no one to answer and a tool the case did not grant is refused. On its
   own in-process server the eval writes the case's pins in that server's tool settings before the apply, and no
   permission; with `--server` it writes nothing.
3. The `learning` folder's notes are written to the agent's learning folder (`PUT .../learning/files/{file}`); the
   server builds `MEMORY.md` from them, so the folder's own `MEMORY.md` is not sent.
4. A run starts with the prompt's body as its input's `content` and its `input` front matter as its typed fields, and
   `max_cost_usd` as its cap, and is waited for (30 minutes at
   most, then cancelled and failed). A run that ends waiting on its person's answer (an `ask_person` question, a tool
   call's approval) is graded as it stands, then cancelled. One paused at its cap, stopped, failed or cancelled fails,
   its `llm` graders not run.
5. Each grader grades what the run left: its final answer, its tool calls (its timeline; and each fake's own log, with
   the whole arguments), and the files of its work folder.

A case passes when every grader passes on every run.

**The output check.** A package with `output` holds every completed run to its schema with no grader file: the run
fails when the server's own read of its answer sets `result.output_error` (its last fenced `json` block missing, not
JSON, or refused by the schema, after the runner's one retry). The report lists it as the grader `output`.

**The graders**, as the runner reads them:

- `regex`: `pattern` with `flags` (some of `i`, `m`, `s`, `u`, `v`) over the whole answer, or over `target`, a field of
  the last `json` block (`a.b` for a nested one; a string as it is, anything else as its JSON). An answer with no such
  field fails the grader, whatever `expect` says.
- `tool_used`: the calls of `tool` (or any of `tools`) by gate name (`write`, `web_fetch`, `mcp:<server>/<tool>`,
  `monid:<provider>/<endpoint>`). A monid endpoint is one the package's `tools` grants by name: a provider's wildcard
  (`monid:<provider>/*`) is filled from monid's listing when the agent is saved, so the eval cannot check a name under
  it before the run. A faked MCP tool's calls are its fake's log, the calls that reached it; any other tool's are the
  timeline's. With `count`, exactly that many calls; else `expect: called`, one or more, or `not_called`, none. `args` keeps the calls
  that carry each of its arguments (an object's own fields compared the same way, any other value equal), on any
  tool's calls: the eval reads the timeline with `calls=whole`, which carries each call's arguments through the run's
  redaction (a held value or a key-shaped string reads `[redacted]`, and so never matches), each string cut at 2,000
  characters.
- `file_exists`: `path`, relative to the run's work folder, among its files.
- `llm`: a run of a grader agent on the same server, with no tools, a fixed instruction and the `--grader-model`. It is
  given the rubric, the run's input, its answer, its tool calls and the calls each fake received, and with `target`
  that field besides (the whole answer stays, for anything else the rubric checks). Each call shows its arguments as
  `tool_used` reads them, its status, and its result's first 8,000 characters through the same redaction. The prompt
  stays under 120,000 characters: past that, the two call lists share what the rest leaves, the longest results (and a
  fake's longest arguments) lose their middle first (marked), then the middle calls, and each list's first line says
  what was cut. The rubric, task and answer are never cut, so they alone can pass the cap. Never another grader, the case's
  description or anything the case expects. It answers `{pass, reason}` in a fenced `json` block; any other answer
  fails the grader.

The report gives each run's cost and each `llm` grade's, as their run records say, and the total.

An eval applies its agents with approvals `never` (the apply's `overrides.approvals`), whatever the package's own
`approvals`: a run that stopped at its first ask would measure nothing. Deny settings and pins hold as at any apply.
The package's default is unchanged, and the report says how it was measured (`approvals: {measured: "never",
package}`, and a line in the markdown).

## agent.md

| Field | |
|---|---|
| `name` | Required. The folder's name: lowercase letters, digits and dashes, at most 64. |
| `display_name` | The agent's name; it may hold `${parameters.<name>}`. Absent: the package's name. |
| `version` | Required. SemVer 2 (`0.1.0`), the package's own version. Never `definition.version`, which is the agent's revision number; a bare number is refused. |
| `description` | Required. Also the agent's description. |
| `license`, `author` (`{name, email?, url?}`), `repository` | Optional, shown in the list. |
| `category` | Optional, shown in the list: one of `engineering`, `security`, `sales`, `marketing`, `research`, `finance`, `operations`, `compliance`, `personal`. |
| `tags` | Optional, shown in the list: at most 8, each lowercase letters, digits and dashes, at most 32, none twice. |
| `harness` | A preference list (`[pi, claude-agent]`): apply takes the first this server runs, else the first. Absent: the server's default. |
| `model` | `{tier: fast \| balanced \| strong, prefer?: "provider/model-id"}`. Apply uses `prefer` when this server runs it on the chosen harness (that harness runs it, a catalog here lists it, and the server holds its provider's key); where it can't, apply refuses with `409 agent_not_runnable` under `model`, naming the model and the fix (save the provider's key in Settings → Model keys, or apply with `overrides.model` or a model choice), and makes nothing: never the tier's model in its place. A package with no `prefer` gets the server's model for the tier: `AGENT_MODEL_FAST`, `AGENT_MODEL` (balanced) or `AGENT_MODEL_STRONG`, each else the default of a model key the server holds. `overrides.model` in the apply wins over both. On a server that reaches its models through a gateway (`AGENT_MODEL_BASE_URL`), `prefer` is not used, since the gateway never said it serves it, and a tier model that is the gateway's own id (no `provider/`) is left out, so the agent runs on the server's default; each is said in a `model` warning. `fast` and `strong` (each `"provider/model-id"`, optional) name the model the agent's `subagent` calls run on for that tier, kept where this server runs them on the harness (else the server's model for the tier, with a `model` warning); the agent's own tier, named in neither, is the agent's own model. Apply writes them as the definition's `model_tiers`. Absent: the server's default. |
| `model.choices` | 1 to 3 named models an owner may pick one of at install instead of the default, each `{id, label, model, harness, warning?, note?, secrets?}`: `id` lowercase letters, digits and dashes, each choice's own; `label` at most 40 characters (`Free model`); `model` `"provider/model-id"`; `harness` one of the package's `harness` list (any harness when it names none); `warning` at most 300 characters, shown word for word beside the choice on the install form whether it is picked or not, never reworded; `note` at most 300 characters, a setup line shown under it (`Turn on OpenRouter Settings → Privacy → ZDR only.`); `secrets` the keys only this choice needs, by name, as the package's `secrets`. The package's own `tier` and `prefer` stay the default. Apply's `overrides.choice` picks one, and the agent runs on exactly its model and harness: where this server can't run it there (the model is not in that harness's catalog here, there is no key for it, or models come through a gateway), apply is refused with `409` naming the model, never swapped for the tier's model the way `prefer` is. |
| `effort` | The thinking level: `low`, `medium`, `high`, `xhigh` or `max`. |
| `tools` | The tools the agent is granted, never an MCP tool (`mcp` grants those). A monid endpoint is granted here by name, `monid:<provider>/<endpoint>` or `monid:<provider>/*`, pinned at the apply's save ([monid](../README.md#monid)); name `MONID_API_KEY` in `secrets` beside it. `subagent` (pi only) lets the agent run a fresh conversation with a prompt and a subset of its own tools (MCP tools and `bash` included, `bash` held to the agent's `tool_policy`), on the agent's own model or one of its tiers (`fast`, `strong`) when the call names one, under its permissions and cap, and get the child's final text back, with an `effort` (`low`, `medium`, `high`) of its own when the call names it; several in a turn run at once, at most 4. A skill can use it to sample K answers, merge them and verify each before acting ([patterns](../README.md#patterns)). Absent: those the server gives a new agent (its box's shell, where it has a box). |
| `mcp` | `[{source, toolkit, tools, required?, reason?, allow?, pin?}]`: the MCP tools the agent uses, by where they come from, never by the name a server saves them under. `source` is `composio` (a Composio toolkit, saved with the Composio preset), `github` (GitHub's MCP server on the GitHub App; its toolkit is `github`) or `url` (any other MCP server). `toolkit` names the tools' set (Composio's toolkit slug, `github`, or the name a `url` server's owner gives it in Settings → MCP servers), lowercase letters, digits and dashes, at most 32, each toolkit once. Inside the package its tools are `mcp:<toolkit>/<tool>`. `tools` are the ones the agent uses (each one tool by its name, `A-Z a-z 0-9 _ -`; never `*`; a Composio action by its slug, `SLACK_SEND_MESSAGE`), `reason` one line (at most 280 characters) on why, shown on the apply screen, and `allow` those of its tools the package asks the owner to grant (`GET /v2/templates` shows each tool with `asks: allow` or `ask`, for a consent screen). Apply maps each need to the saved MCP server whose recorded source and toolkit are the need's (each saved server records them when it is saved, from what made it: the Composio preset its toolkit, a server on the GitHub App (`auth: github_app`) `github`, any other `url` with the toolkit its owner sets; a server on GitHub's MCP address with a token of its own is `url`); where several are, the apply's `servers` (`{<toolkit>: <server>}`) says which, and an apply without it is `422` naming them: a server is never picked for the owner. When the server's name is not the toolkit, apply rewrites `mcp:<toolkit>/` to `mcp:<server>/` in the instructions, the skills and the tool settings. It grants `mcp:<server>/<tool>` only for each tool the apply's `grants` (the owner's answer) name, beside the other tools, with no permission written: each call follows this server's tool settings (under `approvals: ask` a write asks unless the owner allowed it in Settings → Tools, and a read runs unasked only where the server's Allow reads is on). Neither a package nor an apply sets a permission for a granted tool. A tool the owner leaves out is not the agent's at all, under `approvals: never` too, so no harness offers it and a call of it is refused; the owner can grant it later in the agent's tools. Where no saved server matches, the need is not set up here: apply skips it with a warning (`mcp.<toolkit>`, its `fix` saying how to add one: for Composio, the preset with the toolkit and actions), or, when `required` is true, refuses with `409 agent_not_runnable` and makes nothing. `pin`, optional: `{<tool>: {<argument>: <value>}}`, for tools of the entry, 1 to 8 top-level arguments each, every value a scalar (text, which may be or hold `${parameters.<name>}`, a number, `true`/`false`, or `null` for an argument that must be left out) or a list of 1 to 16 of them, the argument one of the list (`event: [null, COMMENT]`), kept with each value once, null first, then by its JSON text, or `{keys: [...]}`, 1 to 16 key names an object argument may hold, any values (`properties: {keys: ["${parameters.crm_score_property}"]}`; a key that is a list parameter's placeholder alone adds each of its items). Apply writes it, filled, as the tool's `pin` in the agent's `tool_settings` (text that is one placeholder alone takes the parameter's value and type), whatever the tool's permission, and the gate refuses any call not as pinned; a pin the server's own settings (Settings → Tools) set for the tool holds too. A pinned tool takes only the arguments its listing declares (and its pinned ones): any other is refused. A pin whose parameter apply is not given sets the tool to `deny` instead, granted or not, with a `pins.mcp:<server>/<tool>` warning. `GET /v2/templates` shows each need's `source`, `toolkit` and `reason`, and each tool's `pin`, unfilled. |
| `tool_policy` | `{bash: read-only}`: a policy on the agent's bash, the one tool that takes one. Apply writes it as `policy` on bash in the agent's `tool_settings` (`definition.tool_settings.bash.policy`), whatever bash's permission, and the tool gate reads each shell call's command before it runs or anyone is asked. Under `read-only` it refuses, in words the model reads, any command that could write, run code or read outside the run's folder: a program outside the read list (git's read subcommands `diff`, `show`, `log`, `blame`, `grep`, `ls-files`, `ls-tree`, `rev-parse`, `cat-file`, `merge-base`, `status`, `shortlog`, `rev-list`, `diff-tree`, `name-rev`, `describe`; `grep`, `egrep`, `fgrep`, `rg`, `sed -n 'N,Mp'`, `cat`, `head`, `tail`, `wc`, `nl`, `ls`, `find` without `-exec` or `-delete`, `sort`, `uniq`, `cut`, `tr`, `diff`, `basename`, `dirname`, `echo`, `true`), a redirection other than `2>/dev/null` and `2>&1`, `$` and backticks, a subshell, `\|\|` or a lone `&`, a pipe into anything but a filter (`head`, `tail`, `sed -n`, `grep`, `wc`, `sort`, `uniq`, `cut`, `tr`, `nl`), an unquoted glob (a glob is quoted, and only in a grep pattern, an `--include=` value or a `find -name` value), a path outside the run's folder, or one on the never-open list (`.env*`, `.ssh/`, `id_rsa*`, `*.pem`, `*.key`, `.npmrc`, `.netrc`, `.git-credentials`, `credentials`), which refuses a command that names such a file but is no fence around the folder: a recursive search reads all it holds, the run's own files and never a key of the server's. `git -C <dir>` is allowed to a directory inside the folder. A line with a `cd` joins its commands with `&&` only. `bash_background` and `bash_input` are refused under it. The check reads the command, never the folder, so a symbolic link in the folder reaches what the computer lets it; and it holds bash alone, so a read-only agent's tools are `read` and `bash` (one that may write can change what git obeys). Approvals `never` lifts none of it. A package with `tools` grants `bash` among them. |
| `computer` | `default` (or absent): the agent runs where this server puts a new one. Or a preference list, `[shell, none]`, read like `harness`: apply takes the first entry this server meets now and saves it as the agent's `computer`. `shell` is a computer that gives the agent a shell here: Archil's serverless exec on the runner when Archil is on (Settings → Workspace; `bash` alone, so `bash_background` and the other background tools are not granted), else the Docker sandbox where Docker answers. `none` is no shell, and is always met: the shell tools in `tools` (`bash` and the background tools) are not granted, and neither is `tool_policy`'s bash. A package with no `tools` is given the chosen shell's tools, as a new agent in a box is given the box's. A fallback, or a tool not granted, is said in a `computer` warning on the apply. A list with `shell` alone, where there is none, refuses the apply (`409`, nothing made). A list without `shell` grants no shell tool, so one in `tools` is refused, and so is an entry after `none`, which would never be picked. The choice is made at apply: a server that gains a shell later gives it to an agent applied again. `GET /v2/templates` shows the list as `computer`, and as `computer_here` what an apply here would pick now: the entry, the agent's `computer`, the shell in words, the tools it would not grant, and the warning or refusal. |
| `checkout` | `pull_request` only: apply sets the agent definition's `checkout`, and the server checks out the pull request each run's GitHub event names before its first turn, in `repo/` of the run's folder, detached at the head, with its base and their merge base (refs `pr/head`, `pr/base`, `pr/merge-base`: `git diff pr/merge-base pr/head` reads the change). The server fetches it with its GitHub App's token, narrowed to that one repository and `contents: read` and revoked after the fetch, or anonymously with no App; the agent never holds a token, and nothing of it is left in the folder or the checkout's git config. The run's system prompt says what was checked out, or why nothing was, so the package's instructions can fall back to the GitHub MCP. It is removed when the run's claim ends. With `tool_policy: {bash: read-only}` the agent reads it with git's read subcommands and never fetches itself. |
| `parameters` | The setup an owner fills once, at apply. Written exactly as `inputs` are (the same keys, the same rule: required unless `required: false`, a `default` only on one that is not) and compiled by the same code; `GET /v2/templates` shows them as a JSON Schema like `input_schema`, and the console's Apply form is the run form. The one difference is where they are filled: apply takes them in `parameters` (a blank one takes its `default`; they are checked as a run's input is, with the same `422` words under `parameters.<name>`), and puts them where the package writes `${parameters.<name>}`: `display_name`, the body, a trigger's `target.input`, a schedule's `cron` and `timezone`, the `in` values of a github or webhook trigger's `accept` where conditions, a trigger's `enabled`, and an `mcp` entry's `pin` values, nowhere else. Text takes the value as text (a list as its items joined by `, `). A `target.input` value or a pin value that is one placeholder alone takes the value with its type (a list pinned is a one-of); in `target.input` one given no value is dropped, so the input schema sees the field absent. A trigger's `enabled` takes only one placeholder alone, naming a boolean parameter with a default: the trigger is made on or off by its value. A parameter a where takes is required or has a default, so the filter never fills empty; one a schedule uses has a default, which the package's own schedule is checked with, and apply checks every trigger with the values given before it makes anything (`422` under `triggers.<i>`). |
| `inputs` | By name: each run's typed input, which apply compiles into the agent's `input_schema` (a closed JSON Schema object). Each is `{type: string \| number \| integer \| boolean \| array, required?, title?, description?, examples?, default?, enum?, pattern? and format? (strings), minLength?/maxLength? (strings), minimum?/maximum? (numbers), items? (an array's scalar, with that scalar's keys)}`, nothing else; an input is required unless it says `required: false`, and a `default` is for one that is not. `format` is `uri`, `email`, `hostname`, `date`, `date-time` or `uuid`, which the server checks, or `cron` or `timezone`, which a form reads. A default and each example are checked against their own input. `content` is the run's message: named, it is a string. Every path that starts a run (the API, the CLI, a trigger, the console) checks the input against it and refuses one that does not meet it with `422 input_invalid`, a path per field (`input.country`). The model is sent the input's `content`, then the other fields as one fenced `json` block under the line `Input:`, so the instructions read each field by its name. `GET /v2/templates` shows it as `input_schema`, and the console's run form is drawn from it. A trigger's `target.input` and an eval case's `input` are checked against it too. Absent: a run takes `{content}`, as before. |
| `secrets` | Variable names (never values) the server must hold: a model or tool key Settings saves (`OPENROUTER_API_KEY`, `PARALLEL_API_KEY`, ...), set where it starts or saved there. Any other name is refused: the server could neither save it nor hand it to a run. Apply refuses with `409 agent_not_runnable`, making nothing, when one is missing. |
| `budget` | `{per_run_usd}`: each run's cap (the agent's `max_cost_usd`), required when the package has triggers. A call count belongs in the instructions ("about 30 calls"); the cap is the hard stop. |
| `learning` | `true` or `false`: whether the agent's runs learn. |
| `approvals` | `ask` (the default: the agent asks its person before a tool runs) or `never` (it runs unattended). The package's recommendation, shown as `approvals_default` for the apply screen; a template whose job runs on triggers says `never`. `never` only skips asking for the tools the agent was granted: an MCP tool the owner left unticked at apply is not one. Under `ask`, a ticked tool is granted but not allowed: it follows this server's tool settings, so a write asks unless the owner allowed it in Settings → Tools, and a read runs unasked only where the owner turned on Allow reads for its server. Deny settings and pins hold either way. |
| `triggers` | `POST /v2/triggers` bodies with no `agent_id` (the target is a `start_run`), each with a `name`, unique in the package: the key an upgrade will match triggers by. `enabled` is `true` (the default), `false`, or `"${parameters.<name>}"`, one placeholder alone naming a boolean parameter that has a default (validate refuses any other text there, a parameter of another type, or one with no default): apply makes the trigger enabled or disabled by the owner's answer, the default when it is left out, so a second schedule can be one the owner opts into (`weekly`, default `false`, turning on a `monday-brief` at `0 8 * * 1`). A trigger made off is off as any trigger is: the owner switches it on or off later with `PATCH /v2/triggers/{id}` or the console. |
| `output` | `{schema: <file>}`: the JSON Schema of the agent's answer, a file in the package. It becomes the agent's `output_schema`: the runner puts it in the instructions on every harness and asks once more when an answer misses it. A string property with `contentMediaType: "text/markdown"` is a report the console renders as Markdown. A skill that reads the schema itself keeps the file in its own folder. |

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

`POST /v2/templates/{id}/apply` with `{parameters, grants?, servers?, overrides?: {model?, choice?, approvals?}}` (a bundled package's id is its name).
`overrides.model` runs the agent on a model of the owner's own; `overrides.choice` on one of the package's `model.choices`,
by id, its model on its harness. An id the package does not offer is `422 overrides.choice`, and so is a choice sent
with `overrides.model`. A choice's `secrets` missing is `409 agent_not_runnable`, as the package's are; a choice whose
model this server can't run on its harness is `409 agent_not_runnable` under `overrides.choice`, naming the model, and
nothing is made.

1. The parameters, `grants` and `servers` are checked against the package (`422` naming each field: a grant is one of
   the package's MCP tools as the package names it, `mcp:<toolkit>/<tool>`; `servers` maps a need's toolkit to the
   saved server the owner picked for it, one whose source and toolkit match), then its secrets, its required MCP
   needs and, for a webhook trigger, the server's seal key (`409`), then every trigger as `POST /v2/triggers` checks
   it, its parameters filled (`422` under `triggers.<i>`). Nothing is made yet.
2. The agent is made through `POST /v2/agents`' own function: named by `display_name` (else the package's name),
   described as the package, granted the MCP tools in `grants` alone, from the saved server each need maps to
   (answered as `servers`, toolkit to server or null), `mcp:<toolkit>/` rewritten to that server's name, with no
   permission written, so each call follows this server's tool settings (a write asks unless the owner allowed it there; a tool left out is not granted; one the owner
   denies on this server stays denied, with a `grants.<tool>` warning), each pinned tool with its pin filled (or set to `deny`, with a
   `pins.<tool>` warning, when its parameter was not given), bash's policy from `tool_policy`, its computer the first
   entry of `computer` this server meets (a fallback said in a `computer` warning), its body held to `POST /v2/agents`' 1 MiB limit (`413`), its instructions
   the body with the parameters filled in, its skills and rules as its skill files, its harness and model chosen as
   above, `thinking` from `effort`, `max_cost_usd` from `budget`.
3. Each trigger is made on the agent through `POST /v2/triggers`' own function. One that still fails (the store, say)
   undoes the apply: the triggers made before it are deleted and the agent is archived, and the failure is the answer.
   A webhook trigger's secret is not in the answer: `POST /v2/triggers/{id}/secret` makes one.

Each apply makes a new agent. The same `Idempotency-Key` and body answers the first apply again and makes nothing.

A grant is written as the agent's own tool setting (`definition.tool_settings`), and an agent's setting outranks the
server's, as it does for any agent: a server-wide deny the owner sets after the apply does not reach that agent. To take
a grant back, edit the agent's `tool_settings`.
