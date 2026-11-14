# Giving a template tools

A template names three kinds of tools: the built-in ones every server has, MCP tools from a server the owner saves
(a Composio toolkit, GitHub's MCP server, or any other), and monid's paid data endpoints. This page is how to declare
each in `agent.md`, how to hold a write to the place the owner chose, and what asks the owner and what runs unasked.
The fields themselves are in the [manifest reference](README.md#agentmd); the tool settings behind them are in the
server's [Tools](../README.md#tools) and [MCP servers](../README.md#mcp-servers) sections.

One example runs through the page: a template that reads a project's latest releases, checks your repository's open
issues, and opens one issue when a release needs a look.

```yaml
---
name: release-watch
version: 0.1.0
description: Opens an issue on your repository when a project you depend on ships a release that needs a look.
harness: [pi, claude-agent, codex]
tools: [web_fetch]
mcp:
  - source: composio
    toolkit: github
    tools: [GITHUB_LIST_REPOSITORY_ISSUES, GITHUB_CREATE_AN_ISSUE]
    required: true
    reason: "Reads your repository's open issues and opens one issue there. Every call is held to the repository you set."
    allow: [GITHUB_LIST_REPOSITORY_ISSUES]
    pin:
      GITHUB_LIST_REPOSITORY_ISSUES: { owner: "${parameters.owner}", repo: "${parameters.repo}" }
      GITHUB_CREATE_AN_ISSUE: { owner: "${parameters.owner}", repo: "${parameters.repo}", assignee: null, assignees: null }
parameters:
  owner: { type: string, pattern: "^[A-Za-z0-9][A-Za-z0-9-]{0,38}$", description: "the account that owns your repository, like octo-org" }
  repo: { type: string, pattern: "^[A-Za-z0-9._-]{1,100}$", description: "your repository's name, like widgets" }
inputs:
  project: { type: string, description: "the project to watch, as owner/name on GitHub, like nodejs/node" }
approvals: ask
budget: { per_run_usd: 0.50 }
---
Read the project's releases with web_fetch (https://github.com/<project>/releases.atom). Before you open an issue with
mcp:github/GITHUB_CREATE_AN_ISSUE, list the open ones and skip a release that already has one. ...
```

## Declare

**Built-ins** go in `tools`, by name: `web_search`, `web_fetch`, `read`, `write`, `bash`, `browser` and the others in
the server's [tool table](../README.md#tools). `web_search` and `web_fetch` need no key and are allowed by default. A
template that only reads public pages (another project's releases, a status page) reads them with `web_fetch`, with no
credential at all.

**MCP tools** go in `mcp`, one entry per toolkit, by where they come from, never by the name an owner saves a server
under:

- `source: composio`, `toolkit: <slug>`: a [Composio](https://composio.dev) toolkit (`github`, `slack`, `gmail`,
  `hackernews`, ...). `tools` are its action slugs exactly as Composio lists them (`GITHUB_CREATE_AN_ISSUE`). The owner
  saves it with the Composio preset in Settings → MCP servers ([walk-through](../../../docs/tutorials/composio.md)),
  which lists every action of the toolkit; `POST /v2/settings/mcp-servers/composio/tools` lists them too. Composio's
  meta tools (`COMPOSIO_MULTI_EXECUTE_TOOL` and the like) are refused: name the direct actions. A save where Composio
  serves none of the picked actions is refused with 422 on `tools` (reason `not_served`), naming them: pick another
  action. Deleting the server in Settings removes it from Composio too; when Composio can't be reached, the answer
  says to remove it there yourself.
- `source: github`, `toolkit: github`: GitHub's own MCP server on the server's GitHub App.
- `source: url`, `toolkit: <name>`: any other MCP server, matched to the toolkit name its owner gives it in Settings.

Inside the package (instructions, skills, eval grants and graders, pins) a tool is `mcp:<toolkit>/<tool>`. At apply
the server maps each entry to the owner's saved server with the same source and toolkit, asks the owner to pick when
there are several, and rewrites `mcp:<toolkit>/` to that server's name wherever the package says it. An entry with no
matching server is skipped with a warning that says how to set it up, or, with `required: true`, the apply is refused
and nothing is made.

**Only what the owner ticks is granted.** The apply screen shows each entry's `reason` and a tick box for each of its
tools, none ticked. `allow` lists the tools you ask the owner to tick; the owner's ticks (`grants` in the apply call)
are the whole grant, and a tick grants a tool without allowing it (see [Ask](#ask)). A tool left unticked is not the agent's: no harness offers it, a
call of it is refused, and `approvals: never` does not change that. Write the `reason` for the person deciding: what
the tools read, what they write, and where the pins hold them.

**monid** gives an agent paid data endpoints on one key. Today a template names the three catalog tools,
`tools: [monid.discover, monid.inspect, monid.run]`, and `secrets: [MONID_API_KEY]`, so an apply on a server without
the key is refused up front. The owner saves the key in Settings → Tool keys. Each `monid.run` is held at its price
under the run's cap before it is sent, and its charge is its own line in the run's cost.

**Finding and combining.** A run lists every tool until its MCP and monid tools pass 20; past that they are left
unlisted, and the model finds them with `tools_search` and calls them with `tools_call` (Claude Code's own tool search
does this there, so it gets neither). `codemode` runs a short JavaScript script that calls several tools in one step
(`await tools.<name>(args)`), on every harness but Codex, which uses its own code mode. You don't declare any of them.
A call made through them is the tool's own call: asked about, pinned and priced exactly as a direct call is. An MCP
tool's result reaches a script as the server's text (Composio's is JSON in a string), so parse it before reading its
fields. With more than 20 such tools, tell the model to search for what it needs rather than listing every tool in the
instructions.

## Pin

A pin fixes a tool's arguments, so a call can only go where the owner said. Put it on every tool that takes a
destination or a scope (an `owner` and `repo`, a channel, a recipient), reads included when the agent reads text
someone else wrote: an issue, a page or an email can ask the agent to read another repository and post what it found.
A tool you can't pin to a scope (a free-text search across everything the credential sees, such as
`GITHUB_SEARCH_ISSUES_AND_PULL_REQUESTS`) doesn't belong in such a template; use the list and read tools instead.

`pin: {<tool>: {<argument>: <value>}}`, 1 to 8 top-level arguments per tool, each value one of:

| Value | Means | Example |
|---|---|---|
| a scalar | the call must carry exactly this | `repo: widgets`, `draft: true` |
| a list | one of these (1 to 16) | `event: [null, COMMENT]` |
| `null` | the argument must be left out | `cc: null`, `bcc: null` |
| `${parameters.x}` | filled from the owner's answer at apply; a placeholder alone keeps the parameter's type, and a list parameter pins a one-of | `owner: "${parameters.owner}"` |
| `{keys: [...]}` | the argument, when given, is an object with only these keys, any values | `properties: {keys: ["${parameters.score_field}"]}` |

A pinned tool takes only the arguments its listing declares, so a destination's other spellings (Slack's `channel_id`,
Gmail's `to`) are refused; you don't pin them. A pin whose parameter the owner leaves empty (absent, `""` or an empty
list) sets that tool to deny, ticked or not, and the apply's `pins.<tool>` warning names the parameter: a send with no
destination never runs; a keys pin whose parameter is empty does the same. A keys pin bounds one argument: pin `null`
any other declared argument that can set the same fields (HubSpot's `custom_properties` beside `properties`). Fence
every other argument that reaches the same place the same way: Gmail's `user_id` also picks the sender, so pin it to
`[null, "me"]` beside `from_email: null`.

## Ask

- Ticking grants a tool; it doesn't allow it. Under `approvals: ask` (the default) a ticked write asks the owner before
  it runs. A ticked read runs unasked where the owner turned on Allow reads for that server, and asks otherwise. A
  destructive tool (`destructiveHint`) takes a second confirm, and a tool granted later follows the same rule. The
  owner answers on the run's page or with `POST /v2/runs/{id}/approvals/{approval_id}`.
- `approvals: never` is the owner's choice at apply, for runs nobody watches (triggers); the apply screen says so next
  to Never. Recommend it in your README when the template must act unattended, and don't promise both "writes ask"
  and unattended. It only lifts asks for granted tools: a deny and every pin still hold.
- Pins are checked before anything is asked or run, whatever the setting, and again after an approval.
- Each ticked write is a promise to the owner: make it narrow (pinned), say it in `reason`, and give the eval set a case
  where the input tries to send it elsewhere.

## Proven live

As of 2026-11-14, these have run end to end against the real service, through the server's own gate:

| Tools | What ran | Harnesses |
|---|---|---|
| Composio `github` (a connected account) | reads; `GITHUB_CREATE_AN_ISSUE` pinned to one repository, asked and refused | pi, Claude Code, Codex |
| Composio `github` poll trigger `GITHUB_ISSUE_CREATED_TRIGGER` | a new issue started a run; use poll triggers, as the webhook type `GITHUB_ISSUE_ADDED_EVENT` needs admin rights on the repository | one run (a trigger starts a run whatever the harness) |
| Composio `hackernews` (no account) | reads; `HACKERNEWS_GET_FRONTPAGE` is not served even when allowed, and the preset names such a tool under `not_served` | pi, Claude Code, Codex |
| monid, litescrape `/github/repository` | `monid.run` from a `codemode` script, a real charge of $0.00015 on its own cost line | pi, Claude Code, Codex |

Through `codemode`: proven on 2026-11-14, one script that read GitHub, ran a monid endpoint and was refused a pinned
write, on all three harnesses (Codex in its own code mode). That template had fewer than 20 MCP and monid tools, so
no run was offered `tools_search` or `tools_call`.

Listing only: `slack`, `gmail`, `googlecalendar`, `linear`, `hubspot`, `stripe` (actions checked against Composio's
listing). Listing-only toolkits work the same way; their live proof is pending a test account. Run your eval set
against a real account before you publish, and say in the template's README which account type you tried.
