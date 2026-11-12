---
packages: @parcha/agentrun-serve, repo
kind: feature
---
A model node says which model it ran on, so a node on a cheaper tier reads as cheaper:
- A learned workflow's call: each model node on its `tool_result` row's `learned_nodes` carries `model` (the model the run's route sent it to) and `tier` (when the node named one), and the Timeline reads "extract · fast · gpt-5-mini", or "extract · gpt-5-4-mini" for a node of no tier.
- A workflow run's graph (`GET /runs/{id}/graph`): each model node that ran carries `model`, and `tier` when it named one (the run keeps each tier's model as it resolves it); a decision node's `model` is its provider's. The console's graph card and node details read the same.
- A call node never carries a model.
Upgrading: nothing to do; a run from before this keeps no models, and its nodes read their kind alone.
