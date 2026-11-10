---
packages: @parcha/agentrun-serve
kind: fix
---
A learning run whose start couldn't use its agent's notes says why, as before the runner moved: "the agent's notes could not be read" when the learning folder couldn't be read, and "could not be copied into the run" when what was read couldn't be made into the run's start. Before, every such run said the latter. A run's launch records the reason (`learning.seedFailed`: `unreadable` or `not_copied`). Upgrading: nothing to do.
