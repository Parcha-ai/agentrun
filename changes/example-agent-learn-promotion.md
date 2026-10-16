---
packages: repo
kind: docs
---
The `examples/agent-learn/` demo now shows a workflow earning its place. After run 2's workflow is admitted as a trial,
runs 5 to 7 are offered it, load it by name and run it with the DSL's `agentrun` tool; `finishRun` proposes their uses from the
records the tool left in each run's own store, and curation promotes the trial to active on the third clean use. Run 8 saves a
second revision that hands an issue with no body to a person; runs 9 and 10 escalate at its gate, so curation demotes it and
the first revision is active again, and a run that saves the demoted document again proposes nothing. The README has a new
section, "A workflow earns its place", with the rules: three clean uses promote, two failed or escalated uses in a row demote
and roll back, and a demoted revision never returns. The tests read each use from the tool's own records.
