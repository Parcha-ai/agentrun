---
packages: @parcha/agentrun-serve
kind: breaking
---
A pending approval says why a call its setting allows asks in a field of its own, `asks_because` (on `pending` of GET /runs/{run_id} and the run list), and no longer among the call's arguments: `args_preview` is the model's arguments alone, with no `asked_because` key, and `summary` no longer ends "Asks because ...". A client that read the reason from `args_preview`'s `asked_because` (or from the end of `summary`) breaks: read `asks_because` instead, absent on a call that asks by its setting. The console's approval card, on the run page and on Mission Control, says "Asks because <why>." above the arguments' box.
