---
packages: @parcha/agentrun-learn
kind: feature
---
`reflectPrompt({ run, dir })` and `reflectBudget(capUsd)`. The prompt is what a host sends as one more turn once a run has answered: the agent writes the memo's four sections under the host's front matter, and its notes, into the learning repository checked out in `dir` on `runs/<run id>`, with its own tools, and commits them when it can run git. It names no harness's tool, keeps the rule against writing the case's data or a secret, and refuses a run id or a directory that would reshape it. `reflectBudget` is the reflection's reserve: a tenth of the run's cap, at most $0.25, and $0.05 for a run with no cap.
