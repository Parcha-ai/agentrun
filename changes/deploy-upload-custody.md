---
packages: @parcha/agentrun, @parcha/agentrun-serve
kind: fix
---
`agentrun deploy DIR` uploads the folder's package and nothing else of it: `agent.md`, the `skills/`, `rules/` and `evals/` trees, and the answer's schema file `agent.md` names (`output: {schema}`) at the folder's root. A `.env`, a key, a README or any other file or folder beside them stays on this machine. A folder with no `agent.md` exits 2 with nothing sent.
- Deleting an agent (`DELETE /v2/agents/{agent_id}` once archived, as `agentrun deploy delete` does) also removes the uploaded package (`upload:<name>`) it was applied from, in the same write, when no other agent on that server, archived or not, was applied from it. A package imported from GitHub stays. Before, an upload stayed until the next upload of its name, and a server that serves the API alone could never remove one.
- A deploy, rollback or delete that waits for another CLI to finish saving its deploy record says so on stderr.
