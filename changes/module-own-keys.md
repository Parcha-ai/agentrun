---
packages: @parcha/agentrun-serve
kind: fix
---
Only a built-in harness owns a key. A harness module's entry that names a run secret in `ownKeys` no longer withholds it from other harnesses' runs; Cursor's `CURSOR_API_KEY` still goes to Cursor's runs alone.
