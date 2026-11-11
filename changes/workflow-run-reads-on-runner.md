---
packages: @parcha/agentrun-serve
kind: fix
---
What a run shows on the runner is right again:
- A run a provider's content filter stopped fails `moderated`, in words a person can act on ("The model provider stopped this answer (its content filter). Rephrase the request, or try another model."), on every harness. It failed `run_failed` in the provider's words. The Timeline's error row keeps them.
- An escalated run's `review` names the escalate node's kind, its label and its summary (`{kind: "review", node: "too big", reason: "needs a person"}`), in the run, in the lists and after a restart. It read `kind: null, node: null` and the reason "escalated at <node>".
- `GET /runs/{id}/graph` lists a workflow's call nodes' calls in `effects` again, each with its status and, for a refused one, the gate's words. The runner kept no node log, so every workflow run's `effects` was empty.
- An `llm` call's answer names the model it ran on as the run names it (`faux/faux-strong`), not the runner's internal session provider (`workflow-session-strong/faux-strong`).
- A workflow run refused for a wrong-typed input field (`input at #/properties/question`) is offered an input its workflow takes (`example`), as a missing or wrong-shaped input already was.
