---
packages: @parcha/agentrun-serve
kind: fix
---
No run on a `--faux` start is handed a model key any more. Before, an agent's process got its revision's model's key, a workflow run got the key of its host model (`AGENT_MODEL`, or the default a saved key gives), and any run could get a model gateway's key, whether the gateway was set where the server starts or saved in the console. The faux model sends no key, so these were real keys the run never used; a run now holds only the keys its tools run on.
