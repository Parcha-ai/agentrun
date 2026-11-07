---
packages: @parcha/agentrun-serve
kind: fix
---
A capped Claude Code, Codex or OpenCode run is no longer told to wrap up right after its first request when its requests are cheap. With nothing priced yet, the first request's admission judges the wrap-up on that request's estimate. That judgement was kept after the first real cost came in, so a run spending about a cent a request heard the wrap-up from its second request on. From the first priced request on, only the run's measured typical request cost decides, as on pi.
