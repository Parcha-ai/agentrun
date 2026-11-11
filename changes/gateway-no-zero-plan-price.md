---
packages: @parcha/agentrun-serve
kind: fix
---
A gateway model is never priced at $0 by a subscription plan's listing in the model catalog. `deepseek-v4-flash`, which the catalog lists under its bare id only on $0 plans, was booked at $0 through a metered gateway: its runs and grades cost nothing and passed any cap. It now takes the metered price a gateway lists under its vendor's id (`deepseek/deepseek-v4-flash`). A model listed only at $0, with no metered listing anywhere, has no price: its cost reads unknown and a cap refuses it, as for any unpriced model.
- Upgrading: a model you run through `AGENT_MODEL_BASE_URL` that the catalog lists only at $0 now needs `AGENT_MODEL_PRICE` under a spend cap.
