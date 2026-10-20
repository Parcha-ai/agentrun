---
packages: @parcha/agentrun-harness
kind: fix
---
A workflow node that names no thinking level now runs at `medium` in the harness, as in the DSL's runner (Miguel's ruling: thinking is never off, and the default is medium). A node that carries `off` runs at `medium` too. A node's own level still wins.
