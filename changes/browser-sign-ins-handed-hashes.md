---
packages: @parcha/agentrun-serve
kind: fix
---
A run's `serve.json` keeps the SHA-256 of each browser sign-in pointer it was handed, as a list (`sign_in_handed`), instead of `true` for a run handed several. A restarted server reads back each of them, live or forgotten, and withholds a run only while one of its own can't be read back: forgetting the agent's other sign-ins (past the newest 32 kept) no longer withholds every run handed several, and a run handed several that was hidden while the seal key was missing is shown again, cut, once the key is back.
- A run still going whose `serve.json` is damaged keeps its agent's sign-in from being forgotten whether this server has read it in or not: both read the same answer.
- Upgrade: a run marked by an older build (`true`, or a single hash) is read as handed a sign-in no one can name, so it is withheld (hidden if still going), never served uncut. There is no migration.
