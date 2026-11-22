---
packages: @parcha/agentrun, @parcha/agentrun-serve
kind: fix
---
A hidden file or folder inside a package's `skills/`, `rules/` or `evals/` (a `.env`, a `.DS_Store`) is no part of the package: `agentrun deploy` does not send it, and the server's package reader leaves it out of an upload, a GitHub import and a folder alike.
- Deleting an agent removes its uploaded package only when the upload stored under that name is still the one the agent was applied from (its sha256): a newer upload of the same name, waiting for its apply, stays.
- `agentrun deploy` prints a target's 501 as every command prints one, the unsupported error with its reason, and exits 5.
- `agentrun deploy AGENT_ID` from an install that refuses its trigger routes, or is not reached once the deploy is applied, exits 0 as deployed: it says the agent's schedules there could not be read (with `--pause-source`, read or paused), with the install's status and message, and never says a schedule it did not turn off is paused. It used to stop there, exit 1 with no answer on stdout, the agent already deployed.
- `agentrun deploy AGENT_ID` keeps each lock in a file of its own in the CLI's config (`deploy.<hash>.json`, 0600), and each address it deployed to as an empty file under `deploy-targets/`, so two CLIs deploying at once never write back what the other changed, and none waits on another's save.
- An agent's export names the keys its apply kept on the revision; the export report no longer has a `secrets` entry, and `report.blocked[].kind` and `report.remade[].kind` no longer list it.
- The skill's command reference names each route a hand-written command calls (`agentrun export`, `agentrun deploy`, `deploy rollback`, `deploy delete`).
- A correction to 0.1.0-beta.53's note, which said an export "no longer copies a credential in the clear into a package": it no longer copies a field named like a credential, or an address with a user part or a credential-named query parameter. A credential under any other name is copied as it is.
