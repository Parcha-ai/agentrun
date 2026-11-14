---
packages: repo
kind: feature
---
Computerd draws each `ui.act` step's place into `screen.watch` frames: a pointer where the step acted, a ring on each press or click, and a box around text it typed, so a live view or a recording shows what the agent did and where. The macOS CI job now records each demo task as a movie cut to the task's own windows, with a caption per step, both scripted and by an agent through agentrun-serve's code mode.
