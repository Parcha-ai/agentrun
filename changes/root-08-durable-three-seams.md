---
packages: repo
kind: breaking
---
`@parcha/agentrun-pi/durable`: three seams for a durable host.
- Breaking: `readJournal(file, key)` and `durableDoc(file, kind, key?)` take the run's store file instead of a directory. They no longer look for `<directory>/durable/run.sqlite`, so a store is read where its host keeps it (pi-durable-disk keeps it at `store/run.sqlite` under the claim); a directory passed as the file throws. `committedRoutes(state)` is unchanged.
- `decisionRecovery(invocation)` returns `{ recordDecision, decision }` for a workflow task, from the invocation the host's `run` is handed: `recordDecision` commits each decision receipt as a row through the task's own commit, in the order receipts are recorded, and `decision(id)` answers `recovery.decision` from the last answered row that run recorded under that id, so a resumed run does not ask the judge again. `DecisionRow` gains four optional fields, `decision_id`, `request`, `state_sha256` and `run_key`, which make the row the whole receipt again for the run that asked it; another run in the same Session is never answered from it. The row version stays 1; a row without them is read as before and never answers.
- `WorkflowTaskHost.options` is documented as where a host settles an effect a killed process left unknown: an effect it completes there (`journal.complete`, before the driver opens) is answered from that result and is not dispatched again. No change in behaviour.
