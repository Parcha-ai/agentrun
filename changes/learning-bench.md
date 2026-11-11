---
packages: repo
kind: feature
---
A learning bench: `node packages/serve/scripts/learn-bench.mjs` runs repeated jobs (`packages/serve/learn-bench/<job>/`: a job.yaml, each step's prompt and graders) with learning off and on, on pi and claude-agent, and writes one JSON results file (`learn-bench/results.schema.json`) and a summary table (`--render`). Each step is graded by the template eval's own graders; the bench adds the follow rate on repeat steps, the work cost per run and its trend apart from the end-of-run learning turn and the grade, the workflow proposal and reuse rates, staleness after a rule change, and wrong keeps after a planted request. Six jobs ship with it (expense, code-review, inbound-lead, kyb, market-monitor, release-notes). It calls real models and spends: run it on demand or nightly, never on a pull request. `--dry` checks every job and plans the runs without spending. Upgrading: nothing to do.
