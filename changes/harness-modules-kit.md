---
packages: @parcha/agentrun-serve, @parcha/agentrun-harness-acp
kind: feature
---
A harness module builds its harness the way the built-in harnesses are built: `entries(builtins, kit)` now gets a kit with `kit.adapterEntry(facts, adapter)` and `kit.acpEntry({ facts, recipe, proxy })`, so the harness is offered its wire's vendor's models, named on that vendor's and OpenRouter's key rows, and gated and named by its own facts. [HARNESS.md](../HARNESS.md) is the guide, and `examples/harness-module` is a whole module (Goose under an id of its own).
- The built-in harnesses read the same facts as before, with or without a module loaded.
- An adapter harness that loads skills itself gives `kit.adapterEntry` a `skillCheck`: the run's skills it accepts are taken out of the prompt and handed to its adapter as `launch.skills`.
- `kit.acpEntry`'s offer promises resume `"restart"` unless given `resume: "load"`, which its recipe must declare (`declares.load`); otherwise its first launch is refused (`HARNESS_RESUME_UNDECLARED`).
- `missing(env)`, on either builder, says what no model key fixes (a binary, say). It is asked before the key, so the harness's offer says it and names no key. An error it or the adapter throws with a `code` refuses the harness with its facts' install fix for that code, as the built-in Goose's are.
- `@parcha/agentrun-serve/conformance` adds `suiteHostTools`, and `@parcha/agentrun-harness-acp/testing` exports the fake ACP agent (`FAKE_ACP_AGENT`, `fakeAgentRecipe`), so a module's author runs the conformance suite with no binary, model or key. The run spec a subject hands `createAdapterLoop` names its harness's `facts`.
