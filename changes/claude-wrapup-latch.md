---
packages: @parcha/agentrun-serve
kind: fix
---
A capped run is told to wrap up when it is really near its cap. Claude Code, Codex and OpenCode runs are no longer told to finish right after their first request when their requests are cheap. Before anything was priced, the wrap-up was judged on the first request's estimate, and that judgement was kept after the first real cost came in. From the first priced request on, only the run's measured typical request cost decides. And on every harness, pi included, a run is also told once what is left falls under twice the next request's least admission, the figure the cap refuses it below. A run whose requests need far more output than they cost, such as a reasoning model at a high effort, is warned before the cap stops it, not refused untold.
