---
packages: @parcha/agentrun-harness
kind: fix
---
A workflow node is offered the tools it declares (`tools`), else every tool the run installs, as the DSL runner does, and `submit`; code mode's `tools.bash` and `vision.*` stay inside its `code` tool. A run with `browser: false` (a demo's `browser: false`) installs no browser: no browser tool, no browser prompt section, and the host's browser is never asked.
