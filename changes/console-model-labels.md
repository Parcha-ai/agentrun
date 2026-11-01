---
packages: repo
kind: fix
---
The console shows a model without the gateway's internal routing prefix: on a server whose models come through a gateway (`capabilities.models.source` is `gateway`), the prefix every tier's model carries is read from `models.default` and taken off on the agent page and in the editor, with the full id in a tooltip. The editor's Model field no longer offers a harness a default it may not run: the server's default is offered for pi, and claude-agent and codex say "No default for this harness: choose a model", as the agent page says for one that names none. Until capabilities say which model each harness takes, a codex agent behind a gateway names its model by hand.
