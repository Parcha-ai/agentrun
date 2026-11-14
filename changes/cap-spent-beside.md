---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A capped run's cap counts what its learning spent on its behalf, so the run and its grades never pass the cap together.
- Before, a follow-up on a run that learned was held only to the run's own spend: an earlier round's grade, which runs as a learning run of its own, was not counted, and the run could end up past its cap by that grade.
- Every gate of the run now reads its own spend plus what its learning runs took: a grade that ended at its cost, and one still under way at its own cap, the most it may take. That covers the model and paid-tool gate on pi and on the CLI harnesses (claude-agent, codex, opencode), the end of a run whose spend passed its cap, the wrap-up note and the tools' wrap-up, the check before a later round looks back, and the cap each later grade runs under.
- A follow-up that doesn't fit parks the run for a raise, as at any spend limit. Its budget card counts the grades in what the run has spent. An uncapped run is unchanged.
- Kernel: `RunSessions.beside()`, when given, is added to the run's spend at each admission (`runBooking`).
