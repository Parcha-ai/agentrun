---
packages: @parcha/agentrun-serve
kind: fix
---
Through a gateway (`AGENT_MODEL_BASE_URL`) with no `AGENT_MODEL_PRICE`, a model id pi-ai's catalog knows now takes the catalog's list price, so its runs' costs are estimated instead of reading $0. A price you set still wins, and an id the catalog does not know is still priced at $0.
