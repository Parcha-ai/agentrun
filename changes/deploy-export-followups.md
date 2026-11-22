---
packages: @parcha/agentrun, @parcha/agentrun-serve
kind: fix
---
A hidden file or folder inside a package's `skills/`, `rules/` or `evals/` (a `.env`, a `.DS_Store`) is no part of the package: `agentrun deploy` does not send it, and the server's package reader leaves it out of an upload, a GitHub import and a folder alike.
- Deleting an agent removes its uploaded package only when the upload stored under that name is still the one the agent was applied from (its sha256): a newer upload of the same name, waiting for its apply, stays.
- `agentrun deploy` prints a target's 501 as every command prints one, the unsupported error with its reason, and exits 5.
- `agentrun agents package` is gone from the CLI: `agentrun export AGENT --out DIR` writes the same package as a folder. The route and the clients' method are unchanged.
- The skill's command reference names each route a hand-written command calls (`agentrun export`, `agentrun deploy`).
