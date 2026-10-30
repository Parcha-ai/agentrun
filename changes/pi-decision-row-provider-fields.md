---
packages: @parcha/agentrun-pi
kind: fix
---
**A decision row keeps the provider that answered, its sources, the questions it refused and how the request ended**
- `DecisionRow` gains optional `status` (`answered`, `failed` or `cancelled`), `provider`, `evidence`, `refused` and `confidence_source`, written from the receipt when it has them. The row writer used to keep only the answers, so a resumed run's replayed receipt lost the provider and the sources its first run had. The replayed receipt now carries them again. A row written before this change has none of them and replays as before.
