---
packages: repo
kind: feature
---
The console says when no model can run. The first screen asks for a model key (a card that saves one through the key routes) while the server's capabilities say `models.ready: false`, and every other page shows a bar with what to set: a model provider's key where the server starts, or one added in Settings, or, when the server's `AGENT_MODEL` names a model it does not run, that. While no model is ready, the console reads the capabilities again every 10 s and when the page comes back into view, so the card and the bar go by themselves.
