---
packages: repo
kind: fix
---
Mission Control's no-model step points at the key card above it. Where the server keeps keys sealed, the first screen shows a card that saves a model key with no restart, yet the start-here panel under it still said to start the server with `AGENT_MODEL` and a provider's key in its environment, then reload. Now it says "Add a model key in the card above, and the templates here run in one click." Where the server keeps no keys, has no seal key to keep them with, or its `AGENT_MODEL` is the problem (which no key fixes), the panel says what to set where the server starts, as before.
