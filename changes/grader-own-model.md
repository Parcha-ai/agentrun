---
packages: @parcha/agentrun-serve
kind: fix
---
A learning agent with no `agree_on` and no fast model (no `model_tiers.fast`, no `AGENT_MODEL_FAST`) now has its check's answers compared by its own model, one request per replay booked as the check's spend (`check_usd`), so a free-text agent whose learned workflow answers right in other words promotes. Before, nothing compared their decisions: only a word-for-word match passed, so such an agent's workflows never served. The check's reason says which model compared ("compared by the agent's own model (<model>; no fast model is set)"); a fast model, where one is set, still compares as before, and `agree_on` still asks no model.
