---
packages: @parcha/agentrun-serve
kind: fix
---
A pending approval says why a call its setting allows asks in a field of its own, `asks_because` (on `pending` of GET /runs/{run_id} and the run list), and no longer among the call's arguments: `args_preview` is the model's arguments alone, with no `asked_because` key, and `summary` no longer ends "Asks because ...". This is a public API change: a client that read the reason from `args_preview` or `summary` reads `asks_because`. The console's approval card, on the run page and on Mission Control, says "Asks because <why>." above the arguments' box.
The console also:
- Takes a run with only a field for an agent whose `input_schema` fields are all optional, as the server does, and says a refusal of neither at the message box.
- Offers the Grade form on an ended run whose learning reads `reflecting`, and says a `409 run_learning` in the server's words, keeping the choice.

A look-back cut by a stop or cancel is said as "a stop or cancel cut it while it wrote what it learned", and the learning state's `reflecting` description names the run's end it reads.
