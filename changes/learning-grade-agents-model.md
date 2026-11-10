---
packages: @parcha/agentrun-serve
kind: fix
---
With no grade model named (`--grade-model`, `AGENTRUN_SERVE_GRADE_MODEL`, the strong tier), a run's learning is graded on the model its agent's revision names, as before the runner moved, and on the host's default model only when the revision names none. Before, the runner graded every such run on the host's default model. An agent's model reached only through OpenRouter is graded there. Upgrading: nothing to do.
