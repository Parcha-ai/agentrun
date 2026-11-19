---
packages: @parcha/agentrun-serve
kind: fix
---
Only a built-in harness owns a key. A harness module's entry that names a run secret in `ownKeys` no longer withholds it from other harnesses' runs; Cursor's `CURSOR_API_KEY` still goes to Cursor's runs alone.
- A built-in's own key goes to the built-in that owns it and to no other harness, built in or not. A harness module whose entry names one in `ownKeys` (`CURSOR_API_KEY`) refuses the server's start with `HARNESS_KEY_OWNED`, naming the module, the id and the key.
