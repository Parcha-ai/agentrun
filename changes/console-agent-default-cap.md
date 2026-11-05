---
packages: repo
kind: feature
---
The console's agent editor sets an agent's default spend cap. Settings has "Default spend cap per run, $" on an agentic agent (not a workflow one): it shows the revision's `max_cost_usd`, and a save sends the number typed. Emptying the field clears a saved cap with an explicit `max_cost_usd: 0`, the server's "no default"; an edit never clears it by leaving the field out. Text that is no number is refused under the field and not sent; the server's own answer on the number shows under it too. A new agent's Create carries the cap typed. An edit keeps every definition field the form does not show.
