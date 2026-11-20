---
packages: @parcha/agentrun-serve
kind: fix
---
`POST /templates/{template}/apply` answers what it did to the agent: `revision_version`, the agent's current revision once it is done, and `agent_change`, `made`, `updated` (a new revision written) or `unchanged` (an update with `agent_id` whose package and parameters the current revision already holds, no revision written). The console's apply result, on Templates and in the API playground, says it from the answer: an update that changed nothing reads "Nothing to update: rev 2 is current.", never that the agent is made or applied.
The console also:
- Takes a run with only a field for an agent whose `input_schema` fields are all optional, as the server does, and says a refusal of neither at the message box.
- Offers the Grade form on an ended run whose learning reads `reflecting`, and says a `409 run_learning` in the server's words, keeping the choice.
- Says on every tool row of a template's install page that the template asks you to grant it, and on a tool whose `asks` is `ask` that each call waits for your OK unless you allowed it in Settings or pick Never ask; no listed tool reads as one the template does not ask for.
- Says on a Triggers row, of any kind, whose agent has tools that ask "Waits for your approval: <tools>" (or "Refused without your approval" with accounts off), as the trigger's page does, reading each agent once.

GET /templates' `mcp[].tools[].asks` description says what it means: every listed tool is one the package uses and asks the owner to grant; `ask` only means each of its calls waits for the owner's OK.

A look-back cut by a stop or cancel is said as "a stop or cancel cut it while it wrote what it learned", and the learning state's `reflecting` description names the run's end it reads.
