---
packages: @parcha/agentrun-serve
kind: fix
---
Console, from a first local run of AgentRun (GRE-4829):
- An agent's page has its run box again: type, Run, and the run's page opens. Handing the run to a coding agent and the API playground are the box's second line; the bar's Run agent hand-off stays for native, SDK and CLI agents, which run where they live.
- "Approvals" reads "Tool approvals" (in the editor and a template's setup): "A tool set to ask waits for your OK before it runs." The editor says it is not about questions, and lists ask_person first among the tools, as "Lets the agent stop and ask you a question" (its blurb on `GET /v2/capabilities` too).
- Connecting GitHub takes the organization as people paste it (its github.com address, its own page at `github.com/orgs/<login>` or `github.com/organizations/<login>/…`, or @name) and says so in words when what was typed is no login or one of github.com's own pages, sending nothing.
- An agent card draws its harness or runtime as its icon alone: the chip in words beside the name ("pi", "Codex") is gone, and the icon is named on hover and for a screen reader ("Pi", "Claude Code"). A template's Harness line shows the same icons, each named, in place of the harness ids.
- One icon rule across the console: a card that stands for an agent or a template leads with its harness's icon (a template's, the harness it prefers first, named with the others). The Templates page's template icon and the Build page's icon picked per template are gone. Where a harness is named, its icon and name show in place of its id: an agent's Harness or Runtime fact, a connected session's Harness, a key's harnesses in Settings, and What runs here. "claude-agent doesn't run on this server" reads "Claude doesn't run on this server".
- The API playground's Start a run has one row: the operation, the agent beside it, and the request's path once.
- The Suggested page's Created agents are cards, as its suggestions are: when each was made, its harness, what it takes and answers, and how far along it is (the agent, its pull request, its first call, once the client its pull request adds is wired in at the line the scan named and its variables are set, then its runs), with reviewing the pull request (or opening it, when it did not open) as the one main action.
- The Suggested page's line on what a repository's app is spans the width of the suggestions under it, both columns.
