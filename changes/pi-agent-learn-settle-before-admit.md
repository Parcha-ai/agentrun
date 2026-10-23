---
packages: @parcha/pi-agent-learn
kind: fix
---
`curate` now settles a run's workflow uses BEFORE it admits the workflows that run saved. The admitter reads `trial.json` as the uses left it. A run that ran a trial cleanly and saved a new revision of the same name now has its use counted on the trial it ran. When that use promotes the trial, the new revision supersedes it, so the trial stays restorable. Before, the run's own save was admitted first and retired the trial, and the run's uses were then held with "they touch a workflow this run also admitted". In a stream where runs both use and save, no trial was ever promoted.
