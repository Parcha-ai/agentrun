---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-acp
kind: feature
---
A harness module builds its harness the way the built-in harnesses are built: `entries(builtins, kit)` now gets a kit with `kit.adapterEntry(facts, adapter)` and `kit.acpEntry({ facts, recipe, proxy })`, so the harness is offered its wire's vendor's models, named on that vendor's and OpenRouter's key rows, and gated and named by its own facts. [HARNESS.md](../HARNESS.md) is the guide, and `examples/harness-module` is a whole module (Goose under an id of its own).
- A harness's facts are read from its entry on the owner's table, so a module's facts reach its offers, key rows, default model, model picker, search and tool gate. The built-in harnesses read the same facts as before, with or without a module loaded.
- `missing(env)`, on either builder, says what no model key fixes (a binary, say). It is asked before the key, so the harness's offer says it and names no key.
- `@parcha/agentrun-serve/conformance` adds `suiteHostTools`, and `@parcha/agentrun-harness-acp/testing` exports the fake ACP agent (`FAKE_ACP_AGENT`, `fakeAgentRecipe`), so a module's author runs the conformance suite with no binary, model or key.
- Modules written for `entries(builtins)` keep working: the kit is a second argument.
