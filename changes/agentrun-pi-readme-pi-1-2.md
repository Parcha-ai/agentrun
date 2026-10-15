---
packages: @parcha/agentrun-pi
kind: docs
---
The install line and the requirement in the package README name Pi 1.2.0, the tested host. `npm install -g @earendil-works/pi-coding-agent@1.1.0` now installs a Pi that crashes on start: its `^` range pulls `pi-codemode` 1.2.0, which no longer exports `MCP_TYPESCRIPT_PREAMBLE`.
