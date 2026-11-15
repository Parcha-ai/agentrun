---
packages: repo
kind: feature
---
The Learning tab's workflow card has a Replay button on a revision that is not serving (edited or held). It starts a replay on the server's default inputs, shows its progress while it runs, and says when it is decided: promoted, or still held and why, with the score. A refusal (`replay_conflict`, `agent_not_runnable`, too few graded runs) shows the server's words. The start stays the owner's console session alone, so the CLI has no replay start by decision (a replay can promote a revision, an owner act); `agentrun learning replay` reads one, and its help says to start one from the console.
