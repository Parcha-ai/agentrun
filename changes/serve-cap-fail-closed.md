---
packages: @parcha/agentrun-serve
kind: fix
---
A run's `max_cost_usd` now refuses whatever it cannot price, on every harness, where it used to let the request through. A capped run on a model with no price (a gateway model with no `AGENT_MODEL_PRICE` that the catalog does not list) or with no output ceiling ends `failed` with `spend_cap_reached` before any request is sent, the reason named. Before, its requests were read as $0 and the cap never refused them. So does a capped run whose spend became unknown (a response that reported no price, a request a crash cut), and, on `claude-agent` or `codex`, one whose model the run's process cannot find, which before ran with no cap at all. A worst case or spend that is not a number refuses too. A run with no cap is unchanged.
