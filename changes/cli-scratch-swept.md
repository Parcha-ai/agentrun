---
packages: @parcha/agentrun-serve
kind: fix
---
A Claude Code, Codex or OpenCode run's files on the server's machine (its scratch folder under `<data>/scratch/`: the CLI's working directory, its home and state, the skills laid for it) are now removed when the run's claim ends, as the data layout always said, instead of staying for ever. Each claim gets a private folder of its own, so a run reopened by a follow-up while the last claim is still letting go never loses the new claim's files. The harness's session comes back from the run's journal at the next claim, as before.
