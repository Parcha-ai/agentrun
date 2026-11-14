---
packages: @parcha/agentrun-serve, @parcha/agentrun-kernel
kind: fix
---
A capped run no longer prices its first request after an approval, a deny or a raise as if nothing were cached, and a Codex or Claude Code run no longer has a tool call refused with "Budget nearly spent" while the request that asked for it is still streaming and the cap has room for both.
- Resume: the session's previous request is kept with the run, so the first request after a new claim is priced from it, warm when that request ended under 4 minutes ago and uncached after that, the same rule as inside one claim, on every harness. Before, a $0.15 Codex run paused after a deny with "needs at least $0.22": its next request was priced all fresh.
- In flight: a CLI harness's request is now sent with the most output whose worst case still leaves the run's wrap-up reserve (one typical step and one least answer) free, so a call it makes mid-response finds room. A $0.50 Codex request that held $0.42 at its whole 32,000-token ask now holds about $0.23. When the request's least and the reserve do not both fit, it is admitted as before, with the most what is left buys, and a call it makes is refused for the reserve as before. pi starts a tool only once its response is complete, so its requests are sized as before.
- The cap's guarantees are unchanged: no request is held past what is left, every hold settles to what the request cost, and turns sum to the run's cost.
- Kernel: `JudgeState.keepUsd`, and `keepBackUsd` on `beforeRequestOf` and `runCap`, tell the rule what the host keeps back beside a request.
