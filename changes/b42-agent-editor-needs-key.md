---
packages: @parcha/agentrun-serve
kind: fix
---
The agent editor keeps a harness whose default model needs a key it lacks as a choice. Its card says "Needs a model key", since a save of it is taken with a warning. A harness off for another reason stays greyed out.
