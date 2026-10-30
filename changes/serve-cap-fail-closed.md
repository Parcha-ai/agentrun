---
packages: @parcha/agentrun-serve
kind: fix
---
A run's cap on `claude-agent` or `codex` now refuses whatever it cannot price, where it used to let the request through. With `max_cost_usd` set, a run whose model this process cannot find, a model with no price (a gateway model with no `AGENT_MODEL_PRICE` that the catalog does not list), or one with no output ceiling ends `failed` with `spend_cap_reached` before any request is sent, the reason named. Before, such a run had no cap at all, or a cap that read its requests as $0. A request whose worst case is not a number refuses too. A run with no cap is unchanged.
