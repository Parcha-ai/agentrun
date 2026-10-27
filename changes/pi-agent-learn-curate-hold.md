---
packages: @parcha/pi-agent-learn
kind: feature
---
A host can ask a person before a run merges. `curate({ only: [runId] })` curates just the runs it names, leaving every other run's branch unjudged; `curate({ hold: true })` plans each run and commits nothing, its report's `planned` holding each plan in plain JSON (`HeldPlan`); and `landHeld({ repo, plan, decision })` lands a held plan once the person decides.
- `"approve"` lands it as curate would have, a merge whose second parent is the run as it lands.
- `{ refuse: reason }` lands the memo alone with the person's one-line reason as its Review, so the run is curated and never judged again.
- A run already curated answers `already`; a main that moved since the plan answers `stale`, and nothing lands. The plan's shape and files are checked before anything is written.
