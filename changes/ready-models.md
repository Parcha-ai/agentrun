---
packages: @parcha/agentrun-serve
kind: feature
---
`GET /v2/capabilities` says, for each harness, which of its `models` a run takes now: `ready_models`, those whose provider is connected here (its key set, or the ChatGPT sign-in where that is how the harness runs them). A model that lacks only its key stays in `models` and is not in `ready_models`. The console's Model picker (the agent editor and the API playground's agent requests) lists the ready ones, each tagged with its provider, shows the others on "Show models that need a key", and says where to connect a provider when none is.
- Breaking: a client that validates capabilities against `harness/5` refuses the new `ready_models` field; the shape's mark is now `harness/6`.
