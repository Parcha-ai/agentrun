---
packages: @parcha/agentrun-kernel, @parcha/agentrun-serve
kind: fix
---
A Claude Code or Codex call that needs approval shows on the run's timeline while it waits, and the test harness for those CLIs asks the tool gate before each call, as the real ones do:
- serve: a CLI call the tool gate asks about goes on the run's record as it parks, its start marked parked, the way an MCP call parked at its door already did. Before, the timeline showed the approval card with no call row above it until the call ran. An allowed call then runs under that one start; a stop withdraws it and its row reads "Not run: the run was stopped while it waited".
- kernel: `askGate(gate, call, signal)` (`process/tools.ts`) is the gate step every tool bridge takes first: undefined for an allow, the refusal for a deny, and a park holds the call until the signal aborts. The faux harness in `@parcha/agentrun-kernel/testing` now asks it before each call: a deny is the call's answer, recorded so it is never asked again, and a park holds the turn. A recovered turn first runs the calls its last request left with no intent and no result (a parked one), under their own ids, as a real CLI's resume does. A test that scripts a faux CLI call to a tool set to ask (a `monid.` or MCP catalog tool by default) now sees the run park on it.
