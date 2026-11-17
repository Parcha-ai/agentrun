---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
`DELETE /v2/agents/{id}` deletes an agent another system owns (one an inline run made with `external`), whole, and answers 204.
- The order is fixed. First the agent refuses new runs, and that refusal is stored, so a run POST, a message that would start a run, a trigger firing, a schedule and an SDK run are all refused (409 `agent_not_runnable`, "being deleted"); then its runs and learning runs are cancelled and waited on until each is final. Then the learning store's own delete runs, and a refusal from it answers 409 `learning_busy` with the agent left refusing runs. Last, its triggers, sign-ins, own computer, disk, folders, kept idempotent answers, runs (journal, launch records, channel posts, changes) and revisions are deleted, then the agent.
- Nothing the agent owns elsewhere is left behind: a trigger's registration upstream, a saved sign-in at its vendor, its own computer and its Archil disk are each deleted there before the record here that names them. While one is not (the vendor or Archil failing, or Archil turned off on this server with a disk still stored on the agent), the DELETE answers 503 `unavailable` (retryable) with the agent kept and refusing runs.
- A run whose launch named an Archil disk (`archil_disk`, the caller's) kept its folder there: that folder is deleted on the disk before the run's launch record, and the disk and everything else on it are kept; a disk Archil says is gone has nothing left to delete. While Archil refuses (a computer still holds the folder, Archil is not reached or is off), the DELETE answers 503 the same way.
- A trigger's adapter settings (a webhook's secret, a poll's cursor) are removed before its row, on this delete and on `DELETE /v2/triggers/{id}`, so a failure between the two leaves the trigger for the next DELETE to find.
- Sending the DELETE again finishes the job after a crash at any step; once it has finished, the agent is 404.
- An API-only server (`AGENTRUN_API_ONLY=1`) serves it too, for the backend that made the agent.
- An agent made here is never deleted: 409 `agent_not_external`, pointing at `POST /v2/agents/{id}/archive`. A run that cannot be ended from here answers 409 `runs_in_flight` (retryable). A server built without a learning delete answers 501.
- Shared things stay: MCP servers, sealed keys, paired computers, tokens and uploaded files.
- The clients gain `deleteAgent` (TypeScript and Python) and `agentrun agents delete-agent`.
