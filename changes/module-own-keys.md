---
packages: @parcha/agentrun-serve
kind: fix
---
Only a built-in harness owns a key. A harness module's entry that names a run secret in `ownKeys` no longer withholds it from other harnesses' runs; Cursor's `CURSOR_API_KEY` still goes to Cursor's runs alone.
- A built-in's own key goes to the built-in that owns it and to no other harness, built in or not. A harness module whose entry names one in `ownKeys` (`CURSOR_API_KEY`) refuses the server's start with `HARNESS_KEY_OWNED`, naming the module, the id and the key.
- A module's ACP recipe (`kit.acpEntry`) that names a key this server holds in its `keys` (`ANTHROPIC_API_KEY`, `OPENROUTER_API_KEY`, any `AGENTRUN_*` or `AGENT_MODEL_*` setting) is refused with `RECIPE_KEY_NOT_OWN` when its run would launch, so the harness's offer says so and no run of it starts. A recipe names only keys saved for its own harness.
