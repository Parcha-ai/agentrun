---
packages: @parcha/agentrun-serve
kind: feature
---
Mission Control shows agents, imported sessions and analytics before the first server-run agent, without requiring a model-provider key. First-use guidance is dismissible; execution setup remains available in Settings and the playground.

Import agents is available from Mission Control and Agents through a remembered coding-agent selector, with separate app and CLI choices. Build, edit, run, query and playground actions use the same control. Prompts target the current server and its OSS skill/MCP/API; importing verifies the destination store and explains the local-to-remote boundary. History import does not connect live external sessions. CLI handoffs copy the prompt, supported app choices open a prefilled prompt, and blocked clipboard access offers selectable text instead of downloading a file.
