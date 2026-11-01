---
packages: @parcha/agentrun-pi
kind: fix
---
A decision row (`agentrun.decisions`) keeps what its receipt says beside the answers: `status`, `provider`, `evidence`, `refused` and `confidence_source`, each when present. A run resumed from its rows gets them back, so a replayed decision gives the same provider and sources its first run had.
