---
packages: @parcha/agentrun-serve
kind: fix
---
A run on a model the runner bridges into Messages (a model whose API is not Anthropic's Messages, or the faux model) shows its thinking on the Timeline again. The runner's model route sent the model's text and tool calls but no thinking block, so the thinking never reached the run's record. It now sends the thinking as a Messages thinking block, its whole text cut by the run's redactor first, so a held key the model quoted in its thinking is never written to the run's record, not only hidden when the Timeline is read.
