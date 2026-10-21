---
packages: @parcha/pi-agent-learn
kind: fix
---
Curation now reports two things it used to lose or stop on.
- A run's `uses/<run id>.json` is read by the same rules the uses settler folds by. A file the settler could not fold (a name pi cannot load as a skill, or more uses than a run writes) is now refused in the report as `uses: the uses file does not parse`. Before, it passed curation's own looser check, the settler held it under a name that is not a workflow, and the run's uses disappeared from the report.
- A `trial.json` on main that does not parse now holds that workflow (`its trial.json on main does not parse (format), so the workflow was held`) instead of throwing out of `curate()` and stopping every later run's curation.
