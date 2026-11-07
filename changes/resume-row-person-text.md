---
packages: @parcha/agentrun-serve
kind: fix
---
An approval's resume row on the Timeline now shows a person's text when opened: the outcome ("web_fetch ran once you allowed it. Its result: …", "… was refused: you declined it." with the refusal's words), with no call id and no "[tool approval]" head. That covers every harness, Claude Code and MCP calls included. The model's own message is unchanged.
