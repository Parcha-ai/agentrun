---
packages: @parcha/agentrun-serve
kind: fix
---
A follow-up to a Codex or Claude Code run a person stopped while a tool call was running is now the run's next turn, as the docs say. Before, when the stop cut a call whose own end never landed before the run's (Codex's write inside its `exec`), the next claim ended that call interrupted and then read the run as already under way: it carried on the stopped turn without the person's message, finished the task, and only then delivered the follow-up as one more turn. The end of a call that started before the stop no longer counts as work after it (also when the claim that wrote that end was lost and another runner takes the run over), so the stopped turn is settled and the follow-up is sent at once.
