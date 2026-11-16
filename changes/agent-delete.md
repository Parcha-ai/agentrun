---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
`DELETE /v2/agents/{id}` deletes an agent another system owns (one an inline run made with `external`), whole, and answers 204.
- The order is fixed. First the agent refuses new runs, and that refusal is stored, so a run POST, a message that would start a run, a trigger firing, a schedule and an SDK run are all refused (409 `agent_not_runnable`, "being deleted"); then its runs and learning runs are cancelled and waited on until each is final. Then the learning store's own delete runs, and a refusal from it answers 409 `learning_busy` with the agent left refusing runs. Last, its triggers, sign-ins, own computer, disk, folders, kept idempotent answers, runs (journal, launch records, channel posts, changes) and revisions are deleted, then the agent.
- Sending the DELETE again finishes the job after a crash at any step; once it has finished, the agent is 404.
- An agent made here is never deleted: 409 `agent_not_external`, pointing at `POST /v2/agents/{id}/archive`. A run that cannot be ended from here answers 409 `runs_in_flight` (retryable). A server built without a learning delete answers 501.
- Shared things stay: MCP servers, sealed keys, paired computers, tokens and uploaded files.
- The clients gain `deleteAgent` (TypeScript and Python) and `agentrun agents delete-agent`.
