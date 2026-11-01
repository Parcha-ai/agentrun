---
packages: @parcha/agentrun-serve
kind: fix
---
The decision keys are held like the server's other secrets. `TYPESAFE_API_KEY` and `PARALLEL_API_KEY` are on the launcher's list, so started by its launcher the server gets them over the secrets pipe and holds them out of its own environment. A workflow run's process gets a decision key on its decision descriptor alone, never with the secrets it is handed over its own pipe, which are its tools' environment. The server chooses Jev's key from the secrets it holds, so a key the launcher handed over, the OpenRouter gateway's included, still reaches the run's judge.
