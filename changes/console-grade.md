---
packages: @parcha/agentrun-serve
kind: feature
---
The console's run page grades a run. An ended run that learns has a Grade control: Right, or Wrong with what was wrong (sent as the grade's `label`; a look-back needs words, and the control says so while they are empty) and, optionally, the correct answer as a JSON object of the fields a right answer holds (`expected`). After the grade it shows "Graded wrong" and "Reviewing" while the feedback round runs, then what the round did; the Timeline shows the grade's words as "Your grade" and the round's look-back. A graded run shows its grade and takes a new one, which replaces it. Runs that don't learn, and runs that only use what was learned, have no Grade control.
`GET /runs/{id}/learning` answers `graded` (`correct`, `source`, `graded_at`): the run's grade as its agent keeps it, absent when it has none.
