---
packages: @parcha/agentrun-computer-bench
kind: feature
---
computer-bench has a new suite, `suites/osworld-pilot`: 20 OSWorld-Verified tasks (Apache-2.0, revision `0ad41bee56`) ported to our Linux desktop, all held out. Ten are terminal tasks, one is a git push, three are VS Code text tasks done in Mousepad, and six are Chrome settings and bookmark tasks done in Firefox. Each task's `source` names its OSWorld id, the revision, the licence notice and what the port changed. Each check reads the desktop's real state: OSWorld's eval scripts, or a Python port of its Chrome getters reading Firefox's profile files. The infeasible Python4 task is decided by the grader with a rubric. `suites/osworld-pilot/arms.json` pits Sonnet 5.5 against GPT-6.1 Terra on pi through OpenRouter, both at thinking `medium`, on E2B desktops. `PORT.md` lists what our desktop can't do of OSWorld's 360 tasks, which oracles only a live verify can prove, and the pilot's command lines, environment and cost.
