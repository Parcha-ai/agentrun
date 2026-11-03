---
packages: @parcha/agentrun-serve
kind: fix
---
An `llm` call whose tier the state fills in (`tier: "{requestedTier}"`) now runs on the model of the tier it asks for. Before, the run registered a model only for tiers written literally, so such a call asking for `strong` or `fast` was answered by the default model (`AGENT_MODEL`) without a word, and billed at its price. A templated tier now registers all three tiers, and their models are checked before the run as a literal tier's is; and a call naming a tier the run has no model for fails with `llm: tier <tier> has no model in this run` instead of falling back. A call that names no tier still runs on the default model.
