---
packages: @parcha/agentrun-serve, @parcha/agentrun-client, @parcha/agentrun
kind: feature
---
`DELETE /v2/runs/{run_id}` deletes a run that has ended whole (its journal and timeline, launch record, messages, files, folders, kept answers and its agent's grades of it), with the runs made from it (its audit's shadow run, the replay runs of its input, a learning run its kept learning names); a run not ended is `409 run_not_final`, nothing deleted, and a delete stopped part way is finished by the next `DELETE`. `DELETE /v2/agents/{agent_id}` now deletes an agent made here too, archived or not, with the same steps as one another system owns, so the code `agent_not_external` is gone. The TypeScript client, the Python client and the CLI (`agentrun runs delete`) carry the new operation.
