---
packages: @parcha/agentrun-serve
kind: fix
---
A Claude Code, Codex or OpenCode run is priced: its model requests are counted at what the run's model proxy booked them at, as a pi run's are at its answers' costs. Its Timeline has a usage row again (the cost, the requests, its paid tool calls), and its run row's cost, its run view's cost, `/v2/usage` and `/v2/stats` carry that figure, where they read $0 or unknown before (#2275). A request booked at no known price, or one with no booked answer yet (in flight, or cut off by a crash), leaves the cost unknown, with what is known so far.
Upgrading: nothing to do. Runs that ended before the upgrade keep the cost their row stored; their Timeline now shows the usage row their booking holds.
