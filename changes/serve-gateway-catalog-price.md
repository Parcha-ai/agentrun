---
packages: @parcha/agentrun-serve
kind: fix
---
Through a gateway (`AGENT_MODEL_BASE_URL`) with no `AGENT_MODEL_PRICE`, a model id pi-ai's catalog knows now takes the catalog's list price, so its runs' costs are estimated instead of reading $0. A revision's `provider/model-id` takes that provider's entry when it is paid; a bare id (`AGENT_MODEL` and the tier variables), a provider the catalog does not list for it, or one it lists at $0 takes the highest price any provider lists: one entry's whole price, the most input plus output, never a $0 entry over a paid one, so a named provider's $0 never switches off `max_cost_usd`. A price you set still wins, and an id the catalog does not know is still priced at $0. A behavior change: a run's `max_cost_usd` now applies to these gateway models and stops the run with `spend_cap_reached` once its estimate passes the cap; at $0 it never fired.
