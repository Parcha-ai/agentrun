---
packages: @parcha/agentrun-serve
kind: feature
---
The console has a Free page (`#/free`) that shows what runs for $0 on the server. It lists the free models, with the ones on this machine's Ollama first and each with its context size. A free catalog model also shows the server's request limit a run. It shows what `web_search` and `web_fetch` go through now, in the server's own `why` words. It lists the templates that run on a free model, each with "Use free", which opens the template's Apply screen with the agent on the server's free default model (apply's `overrides.model`). With no local model, the page says so and keeps a place for the hardware-fit card.
A completed run that cost $0 on free models shows a receipt on its page. The receipt gives the model, why the run was free (a local model on this machine, a free model with its request limit a run, or both), the requests and tokens, each tool's calls and what they went through, the run's time and its $0 cost. A failed or cancelled run, a run whose cost is unknown, and one that cost money show none.
