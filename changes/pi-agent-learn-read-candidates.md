---
packages: @parcha/pi-agent-learn
kind: feature
---
`readCandidates(store)` returns a run's candidates from its store file once no process holds it open, in one read transaction that writes nothing, as `collectCandidates` returns them from the open run; a missing file is a `LearnError` `missing`. A host that ran the agent in another process reads what it noted there.
